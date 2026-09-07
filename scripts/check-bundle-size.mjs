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
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { collectStartupFiles } from "./startup-bundle.mjs";

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
const STARTUP_GZIP_BUDGET = 277_378;

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
