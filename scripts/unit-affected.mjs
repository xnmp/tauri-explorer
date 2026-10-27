#!/usr/bin/env node
// unit-affected.mjs — select the Vitest inputs a diff affects (#1175).
//
// Usage:  node scripts/unit-affected.mjs [--max-files N] [base] [head]
//   Prints a test-selection.mjs Selection as JSON. Its items are files for
//   `vitest related --run`, which runs every test whose import graph reaches
//   one of them (a test file reaches itself).
//
// Rules, in order (over-selection is safe; silent under-selection is not):
//   1. Shared escalations (too many files, unusual path, unknown type) -> all.
//   2. CI selection itself (ci.yml, this script, test-selection.mjs) or the
//      test-result cache wiring (turbo.json, test-cache.mjs, ci-test-unit.sh) -> all.
//   3. Config and lockfiles (package.json, bun.lock, vite/vitest/svelte
//      configs, tsconfig, bunfig) -> all: they change how every test runs.
//   4. Anything under tests/ that is not a *.test.ts / *.bench.ts file is
//      shared setup, a test utility or a fixture -> all.
//   5. A deleted module -> all: no remaining import graph names its importers.
//   6. Changed modules (.ts/.js/.mjs/.svelte/.css) are related inputs.
//   7. Tests also read files as text (workflows, Rust sources, docs, scripts),
//      which the import graph cannot see. Any file under tests/ whose text
//      names a changed file's repo path or basename is a related input, and a
//      test that lists directories is one when it names a changed file's
//      directory. A matched helper selects the tests that import it.
//   Nothing affected -> none.
//   A release version bump (scripts/version-only.mjs) skips rule 3: only the
//   tests that read the bumped files as text are related (#1367).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, allOf, baseName, isModule, runCli, sharedEscalation } from "./test-selection.mjs";

/** @typedef {import("./test-selection.mjs").Selection} Selection */
/** @typedef {{ rel: string, content: string, scansDirs: boolean }} TestSource */

const SELECTION_INPUTS = new Set([
  ".github/workflows/ci.yml",
  "scripts/unit-affected.mjs",
  "scripts/test-selection.mjs",
  "scripts/version-only.mjs",
  // How the target runs through the test-result cache (#1176).
  "turbo.json",
  "scripts/test-cache.mjs",
  "scripts/ci-test-unit.sh",
]);

/** @param {string} f */
const isConfig = (f) =>
  /(^|\/)package\.json$/.test(f) ||
  /(^|\/)bun\.lockb?$/.test(f) ||
  /(^|\/)bunfig\.toml$/.test(f) ||
  /(^|\/)tsconfig[\w.-]*\.json$/.test(f) ||
  /^(vite|vitest|svelte)(\.[\w-]+)?\.config\.(ts|js|mjs|cjs)$/.test(f);

/** @param {string} f */
const isTestFile = (f) => /^tests\/.+\.(test|bench)\.ts$/.test(f);

const DIR_SCAN = /readdirSync|readdir\(|globSync|glob\(|opendirSync/;

/** Every text file under tests/, except fixtures, which rule 4 already covers. */
export function loadTestSources(root = ROOT) {
  /** @type {TestSource[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures" && entry.name !== "node_modules") walk(child);
      } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
        const content = readFileSync(join(root, child), "utf8");
        out.push({ rel: child, content, scansDirs: DIR_SCAN.test(content) });
      }
    }
  };
  walk("tests");
  return out;
}

/** @param {string} file */
function ancestorDirs(file) {
  const dirs = [];
  for (let i = file.lastIndexOf("/"); i > 0; i = file.lastIndexOf("/", i - 1)) dirs.push(file.slice(0, i));
  return dirs;
}

/**
 * @param {string[]} changed
 * @param {TestSource[]} tests
 * @param {{ maxFiles: number, exists?: (file: string) => boolean, versionOnly?: boolean }} options
 *   versionOnly: the diff only bumps release versions (scripts/version-only.mjs)
 * @returns {Selection}
 */
export function selectUnit(changed, tests, { maxFiles, exists = (f) => existsSync(join(ROOT, f)), versionOnly = false }) {
  if (changed.length === 0) return { mode: "none", reason: "no changed files", items: [] };
  const shared = sharedEscalation(changed, maxFiles);
  if (shared) return allOf([shared]);

  /** @type {string[]} */
  const reasons = [];
  /** @type {Set<string>} */
  const related = new Set();
  for (const f of changed) {
    if (SELECTION_INPUTS.has(f)) { reasons.push(`CI test-selection change: ${f}`); continue; }
    if (isConfig(f) && !versionOnly) { reasons.push(`config or lockfile change: ${f}`); continue; }
    if (f.startsWith("tests/") && !isTestFile(f)) { reasons.push(`shared test setup, utility or fixture change: ${f}`); continue; }
    if (isModule(f)) {
      if (!exists(f)) { reasons.push(`deleted module: ${f}`); continue; }
      related.add(f);
    }
    const name = baseName(f);
    const dirs = ancestorDirs(f);
    for (const t of tests) {
      if (t.rel === f) continue;
      if (t.content.includes(f) || t.content.includes(name) || (t.scansDirs && dirs.some((d) => t.content.includes(d)))) {
        related.add(t.rel);
      }
    }
  }
  if (reasons.length > 0) return allOf(reasons);
  const items = [...related].sort();
  const prefix = versionOnly ? "version-only change: " : "";
  if (items.length === 0) return { mode: "none", reason: `${prefix}none of ${changed.length} changed file(s) reaches a unit test`, items };
  return {
    mode: "selected",
    reason: `${prefix}tests related to ${items.length} input(s) from ${changed.length} changed file(s)`,
    items,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli("unit-affected", (changed, maxFiles, { versionOnly }) =>
    selectUnit(changed, loadTestSources(), { maxFiles, versionOnly }));
}
