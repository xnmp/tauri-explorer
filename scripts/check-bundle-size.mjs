/**
 * Bundle-size regression guard. Issue #300.
 *
 * Builds the frontend, locates the main app chunk via the Vite build
 * manifest, gzips it (node zlib, default level — what most servers use),
 * and fails when it exceeds the budget.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs             # build, then check
 *   node scripts/check-bundle-size.mjs --no-build  # check an existing build
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { collectStartupFiles } from "./startup-bundle.mjs";
import { findHookLeaks } from "./release-hook-leaks.mjs";

// Measured 2026-07-12 (chore/perf-regression-guards, post merge of dev):
// main chunk _app/immutable/chunks/*.js was 691,381 bytes raw / 217,992
// bytes gzip. Budget = that gzip size + 10%. Raise deliberately (with a
// note here) when a feature legitimately grows the cold-start payload;
// never raise it just to make CI green.
const BUDGET_GZIP_BYTES = 239_791;

// Full static entry closure at ea256aaf, measured before #680's lazy mock
// split. Guard both parse input (raw bytes, relevant to local Tauri assets)
// and transfer size. Splitting a large chunk must not evade the startup cap.
const STARTUP_RAW_BUDGET = 866_617;
// Raised 277,378 -> 278_400 for #994 (Details Resolution column). dev measured
// 277,120 (258 bytes of headroom); the column's header, row cell, queue and
// keyboard-reveal handler add ~814 bytes gzip (277,934 total; 278,112 after merging later dev work). Lazy-loading the
// cell was measured and does not help: Vite's preload wrapper plus the extra
// chunk cost as much as the moved code. Raw stays well under its cap.
// Raised 278,400 -> 279,424 (+1 KiB) for #1061: pane minima and CSS-sized
// split panes must apply on the first painted frame, so that code is startup
// by nature (+279 bytes gzip over a dev that sat within ~300 bytes of the cap).
// Raised 279,424 -> 279,936 (+512 bytes) for #1081, which adds no startup
// code: its graph-only IPC wrapper lives in a lazy module, and the startup
// closure's raw size matches dev (828,435 vs 828,439 bytes). Gzip still moved
// +85 bytes because content-hashed chunk names in eager import lists changed
// and compress differently; dev measured 279,400-279,408, within 24 bytes of
// the old cap, so any lazy-chunk change could fail on name churn alone.
// Raised 279,936 -> 280,448 (+512) for #863 (in-app Trash): dev measured
// 279,766. Listing, restore, menu actions and refresh load lazily with the
// first Trash listing (~1.7 KiB gzip chunk); what stays eager is the provider
// registration, Trash-aware Details headers and column, the empty-state copy,
// the trashed-item open guards and menu scoping, +278 bytes gzip (280,044
// total). Routing every lazy call through one module was measured; a second
// Vite preload wrapper cost ~100 bytes.
// Raised 280,448 -> 280,960 (+512) for #1298 (caret-less Folder Peek refuses
// a folder double-click with a notice): dev measured 280,435, 13 bytes under
// the old cap. The guard sits in FileList's eager double-click handler and
// adds +188 bytes gzip (280,623) with its shared peek predicate and notice
// copy; a lazy module would add the ~100-byte preload wrapper measured above.
const STARTUP_GZIP_BUDGET = 280_960;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = resolve(repoRoot, ".svelte-kit/output/client");
const manifestPath = resolve(clientDir, ".vite/manifest.json");

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

if (!process.argv.includes("--no-build")) {
  console.log("Building frontend (bun run build)...");
  execSync("bun run build", { cwd: repoRoot, stdio: "inherit" });
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
} catch (err) {
  console.error(`Could not read Vite manifest at ${manifestPath}: ${err.message}`);
  console.error("Run without --no-build, or run `bun run build` first.");
  process.exit(1);
}

/**
 * The cold-start payload is every JS chunk statically reachable from the
 * entry records (SvelteKit route nodes + client entry). The "main chunk" is
 * the largest of those — the +page.svelte import graph. Resolving it through
 * the import closure keeps this stable across hash and chunk-name changes.
 */
const chunks = collectStartupFiles(manifest).map((file) => ({
  file,
  rawBytes: statSync(resolve(clientDir, file)).size,
  gzipBytes: gzipSync(readFileSync(resolve(clientDir, file))).length,
}));
const main = chunks.reduce((max, chunk) => chunk.rawBytes > max.rawBytes ? chunk : max);
const startupRaw = chunks.reduce((total, chunk) => total + chunk.rawBytes, 0);
const startupGzip = chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0);
const gzipBytes = gzipSync(readFileSync(resolve(clientDir, main.file))).length;
const pct = ((gzipBytes / BUDGET_GZIP_BYTES) * 100).toFixed(1);

console.log(`Main chunk:  ${main.file}`);
console.log(`Raw size:    ${main.rawBytes.toLocaleString()} bytes (${kib(main.rawBytes)})`);
console.log(`Gzip size:   ${gzipBytes.toLocaleString()} bytes (${kib(gzipBytes)})`);
console.log(`Budget:      ${BUDGET_GZIP_BYTES.toLocaleString()} bytes (${kib(BUDGET_GZIP_BYTES)}) — ${pct}% used`);
console.log(`Startup JS:  ${chunks.length} chunks, ${startupRaw.toLocaleString()} bytes raw / ${startupGzip.toLocaleString()} bytes gzip`);
console.log(`Startup cap: ${STARTUP_RAW_BUDGET.toLocaleString()} bytes raw / ${STARTUP_GZIP_BUDGET.toLocaleString()} bytes gzip`);

// A release build must carry no E2E hook code (#884). A deliberate hook
// build (VITE_E2E_HOOKS=1) is measured but not held to this rule.
if (process.env.VITE_E2E_HOOKS !== "1") {
  const scripts = readdirSync(clientDir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({
      file: relative(clientDir, resolve(clientDir, file)),
      text: readFileSync(resolve(clientDir, file), "utf-8"),
    }));
  const leaks = findHookLeaks(manifest, scripts);
  if (leaks.length > 0) {
    console.error("FAIL: the release build contains E2E hook code (see src/lib/api/e2e-hooks.ts):");
    for (const leak of leaks) console.error(`  ${leak}`);
    process.exit(1);
  }
  console.log(`Hook check:  no test-support chunk or e2e marker in ${scripts.length} scripts`);
}

if (startupRaw > STARTUP_RAW_BUDGET || startupGzip > STARTUP_GZIP_BUDGET) {
  console.error("FAIL: the full static startup graph exceeds its budget. Inspect eager imports before raising the cap.");
  process.exit(1);
}

if (gzipBytes > BUDGET_GZIP_BYTES) {
  const over = gzipBytes - BUDGET_GZIP_BYTES;
  console.error(
    `\nFAIL: main chunk gzip size exceeds budget by ${over.toLocaleString()} bytes (${kib(over)}).\n` +
      "The cold-start bundle grew. Either code-split the new weight (lazy-load\n" +
      "dialog/feature imports — see docs/perf-review.md) or, if the growth is\n" +
      "intentional, raise BUDGET_GZIP_BYTES in scripts/check-bundle-size.mjs\n" +
      "with a comment explaining why."
  );
  process.exit(1);
}

console.log("\nPASS: main chunk and full startup graph are within their budgets.");
