#!/usr/bin/env node
// impact-coverage.mjs — the browser E2E test-impact map (#1368).
//
// The Chromium fixture (e2e/impact-coverage.ts, E2E_COVERAGE=1) records V8
// precise coverage for every page a test opens and reduces it, per test, to
// two sets of repo source files:
//   loaded     — the module was evaluated in the page (imported, statically
//                or lazily). Its top-level code ran.
//   exercised  — some function other than the module's top-level script ran
//                at least once: a component was rendered, a store method or
//                event handler was called. Being imported at startup does not
//                count, which keeps startup modules from mapping every spec.
// `merge` unions those per spec into the map that PR selection reads:
//   { version, commit, generatedAt, specs: [...],
//     files:  { "src/x.ts": [specs that exercised it] },
//     loaded: { "src/x.ts": [specs that loaded it] } }
// A spec in `specs` recorded coverage; a spec absent from `specs` (new, or its
// coverage was lost) is always selected for a src/ change.
//
// Usage:
//   node scripts/impact-coverage.mjs merge --out map.json [--commit SHA] <dir|file.json>...
//     Reads every *.json coverage record under the inputs (the fixture's
//     per-test records or earlier partial maps) and writes the merged map.
//   node scripts/impact-coverage.mjs stats <map.json>
//     Prints how many specs each file maps to under each rule.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAP_VERSION = 1;

/**
 * Repo path of a script the Vite dev server served, or null for anything that
 * is not a repository source module (Vite client, prebundled dependencies,
 * node_modules, SvelteKit's generated runtime, virtual modules, data: URLs).
 * Query strings are dropped, so a component's `?svelte&type=style` module and
 * a `?t=` HMR re-import count as the component file itself.
 * @param {string} url
 * @returns {string | null}
 */
export function repoPathFromUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  let path;
  try { path = decodeURIComponent(parsed.pathname); } catch { return null; }
  // /@fs/<absolute path> serves files outside Vite's root; only map those
  // that still sit under a src/ directory of this repository.
  if (path.startsWith("/@fs/")) {
    const at = path.lastIndexOf("/src/");
    if (at < 0) return null;
    path = path.slice(at);
  }
  if (!path.startsWith("/src/")) return null;
  if (path.includes("/node_modules/")) return null;
  return path.slice(1);
}

/**
 * @typedef {{ startOffset: number, endOffset: number, count: number }} CoverageRange
 * @typedef {{ functionName: string, isBlockCoverage?: boolean, ranges: CoverageRange[] }} CoverageFunction
 * @typedef {{ url: string, source?: string, functions: CoverageFunction[] }} ScriptCoverage
 */

/**
 * Whether V8 coverage shows code beyond module evaluation: any function other
 * than the script's top-level function (the range starting at offset 0 that
 * spans the whole script) was called. Functions a module calls while it
 * evaluates (a registration helper, an IIFE) count, so a module whose import
 * runs real work is exercised wherever it loads.
 * @param {ScriptCoverage} script
 */
export function scriptExercised(script) {
  const fns = script.functions ?? [];
  let topLevel = -1;
  let widest = -1;
  fns.forEach((fn, i) => {
    const r = fn.ranges?.[0];
    if (!r || r.startOffset !== 0) return;
    if (r.endOffset > widest) { widest = r.endOffset; topLevel = i; }
  });
  return fns.some((fn, i) => i !== topLevel && (fn.ranges?.[0]?.count ?? 0) > 0);
}

/**
 * Reduce one test's coverage (every page it opened) to repo file sets.
 * @param {ScriptCoverage[]} scripts
 * @returns {{ loaded: string[], exercised: string[] }}
 */
export function summarizeCoverage(scripts) {
  /** @type {Set<string>} */
  const loaded = new Set();
  /** @type {Set<string>} */
  const exercised = new Set();
  for (const script of scripts) {
    const path = repoPathFromUrl(script.url);
    if (!path) continue;
    const top = script.functions?.find((fn) => fn.ranges?.[0]?.startOffset === 0);
    // A script whose top level never ran was not evaluated (V8 can report a
    // compiled-but-unrun script with count 0).
    if (top && (top.ranges[0].count ?? 0) === 0 && !scriptExercised(script)) continue;
    loaded.add(path);
    if (scriptExercised(script)) exercised.add(path);
  }
  return { loaded: [...loaded].sort(), exercised: [...exercised].sort() };
}

/**
 * @typedef {{ spec: string, loaded: string[], exercised: string[] }} SpecRecord
 * @typedef {{ version: number, commit: string, generatedAt: string, specs: string[],
 *   files: Record<string, string[]>, loaded: Record<string, string[]> }} ImpactMap
 */

/**
 * Union per-test records (and/or partial maps) into one map.
 * @param {Array<SpecRecord | ImpactMap>} inputs
 * @param {{ commit?: string, generatedAt?: string }} [meta]
 * @returns {ImpactMap}
 */
export function mergeImpact(inputs, { commit = "unknown", generatedAt = new Date().toISOString() } = {}) {
  /** @type {Set<string>} */
  const specs = new Set();
  /** @type {Map<string, Set<string>>} */
  const files = new Map();
  /** @type {Map<string, Set<string>>} */
  const loaded = new Map();
  /** @param {Map<string, Set<string>>} into @param {string} file @param {string} spec */
  const add = (into, file, spec) => {
    let set = into.get(file);
    if (!set) into.set(file, (set = new Set()));
    set.add(spec);
  };
  for (const input of inputs) {
    if ("spec" in input) {
      specs.add(input.spec);
      for (const f of input.loaded) add(loaded, f, input.spec);
      for (const f of input.exercised) { add(files, f, input.spec); add(loaded, f, input.spec); }
    } else {
      for (const s of input.specs) specs.add(s);
      for (const [f, list] of Object.entries(input.files)) for (const s of list) add(files, f, s);
      for (const [f, list] of Object.entries(input.loaded)) for (const s of list) add(loaded, f, s);
    }
  }
  /** @param {Map<string, Set<string>>} m */
  const plain = (m) => Object.fromEntries([...m.keys()].sort().map((k) => [k, [...(m.get(k) ?? [])].sort()]));
  return { version: MAP_VERSION, commit, generatedAt, specs: [...specs].sort(), files: plain(files), loaded: plain(loaded) };
}

/** @param {unknown} v */
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
/** @param {unknown} v */
const isListRecord = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isStringArray);

/**
 * Parse and validate a map for selection. Returns the map, or an error string
 * explaining why selection must fall back.
 * @param {string | null} text
 * @param {{ now?: Date, maxAgeHours?: number }} [options]
 * @returns {{ map: ImpactMap } | { error: string }}
 */
export function loadImpactMap(text, { now = new Date(), maxAgeHours = MAX_MAP_AGE_HOURS } = {}) {
  if (text === null || text === undefined) return { error: "no impact map" };
  let data;
  try { data = JSON.parse(text); } catch { return { error: "impact map is not valid JSON" }; }
  if (typeof data !== "object" || data === null) return { error: "impact map is not an object" };
  if (data.version !== MAP_VERSION) return { error: `impact map version ${data.version} is not ${MAP_VERSION}` };
  if (!isStringArray(data.specs) || !isListRecord(data.files) || !isListRecord(data.loaded)) {
    return { error: "impact map is malformed" };
  }
  if (data.specs.length === 0 || Object.keys(data.loaded).length === 0) return { error: "impact map is empty" };
  const generated = Date.parse(data.generatedAt);
  if (Number.isNaN(generated)) return { error: "impact map has no valid generatedAt" };
  const ageHours = (now.getTime() - generated) / 3_600_000;
  if (ageHours > maxAgeHours) return { error: `impact map is ${Math.round(ageHours)}h old (limit ${maxAgeHours}h)` };
  if (ageHours < -1) return { error: "impact map generatedAt is in the future" };
  return { map: data };
}

/**
 * The oldest map PR selection trusts. The map is regenerated nightly on dev;
 * 72 hours tolerates two failed nightlies. Dev pushes still run every spec,
 * so a dependency that a stale map misses is caught when the PR lands.
 */
export const MAX_MAP_AGE_HOURS = 72;

/** @param {string} p @returns {string[]} */
function jsonFiles(p) {
  if (statSync(p).isDirectory()) return readdirSync(p).flatMap((n) => jsonFiles(join(p, n)));
  return p.endsWith(".json") ? [p] : [];
}

/** @param {ImpactMap} map */
export function mapStats(map) {
  const specCount = map.specs.length;
  /** @param {Record<string, string[]>} rec */
  const dist = (rec) => {
    const counts = Object.values(rec).map((l) => l.length).sort((a, b) => a - b);
    const pick = (q) => counts.length ? counts[Math.min(counts.length - 1, Math.floor(q * counts.length))] : 0;
    return {
      files: counts.length,
      median: pick(0.5),
      p90: pick(0.9),
      mean: counts.length ? +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1) : 0,
      nearlyAll: counts.filter((c) => c >= 0.9 * specCount).length,
    };
  };
  const loadedOnly = Object.keys(map.loaded).filter((f) => !map.files[f]);
  return { specs: specCount, exercised: dist(map.files), loaded: dist(map.loaded), loadedOnlyFiles: loadedOnly.length };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "merge") {
    let out = null;
    let commit = process.env.GITHUB_SHA ?? "unknown";
    const inputs = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--out") out = rest[++i];
      else if (rest[i] === "--commit") commit = rest[++i];
      else inputs.push(rest[i]);
    }
    if (!out || inputs.length === 0) throw new Error("usage: merge --out map.json [--commit SHA] <dir|file>...");
    const records = inputs.flatMap(jsonFiles).map((f) => JSON.parse(readFileSync(f, "utf8")));
    const map = mergeImpact(records, { commit });
    if (map.specs.length === 0) throw new Error("no coverage records found");
    writeFileSync(out, JSON.stringify(map) + "\n");
    process.stderr.write(`[impact-coverage] ${JSON.stringify(mapStats(map))}\n`);
    return;
  }
  if (cmd === "stats") {
    const map = JSON.parse(readFileSync(rest[0], "utf8"));
    process.stdout.write(JSON.stringify(mapStats(map), null, 2) + "\n");
    return;
  }
  process.stderr.write("usage: impact-coverage.mjs merge|stats ...\n");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
