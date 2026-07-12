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

// Measured 2026-07-12 (chore/perf-regression-guards, post merge of dev):
// main chunk _app/immutable/chunks/*.js was 691,381 bytes raw / 217,992
// bytes gzip. Budget = that gzip size + 10%. Raise deliberately (with a
// note here) when a feature legitimately grows the cold-start payload;
// never raise it just to make CI green.
const BUDGET_GZIP_BYTES = 239_791;

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
function mainEntryChunk(m) {
  const seen = new Set();
  const queue = Object.keys(m).filter((key) => m[key].isEntry);
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...(m[key].imports ?? []));
  }

  const chunks = [...seen]
    .map((key) => m[key].file)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({ file, rawBytes: statSync(resolve(clientDir, file)).size }));

  if (chunks.length === 0) throw new Error("no entry JS chunks found in manifest");
  return chunks.reduce((max, c) => (c.rawBytes > max.rawBytes ? c : max));
}

const main = mainEntryChunk(manifest);
const gzipBytes = gzipSync(readFileSync(resolve(clientDir, main.file))).length;
const pct = ((gzipBytes / BUDGET_GZIP_BYTES) * 100).toFixed(1);

console.log(`Main chunk:  ${main.file}`);
console.log(`Raw size:    ${main.rawBytes.toLocaleString()} bytes (${kib(main.rawBytes)})`);
console.log(`Gzip size:   ${gzipBytes.toLocaleString()} bytes (${kib(gzipBytes)})`);
console.log(`Budget:      ${BUDGET_GZIP_BYTES.toLocaleString()} bytes (${kib(BUDGET_GZIP_BYTES)}) — ${pct}% used`);

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

console.log("\nPASS: main chunk is within the bundle-size budget.");
