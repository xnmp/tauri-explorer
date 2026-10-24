#!/usr/bin/env node
// impact-coverage.mjs — the browser E2E test-impact map (#1368).
//
// The Chromium fixture (e2e/impact-coverage.ts, E2E_COVERAGE=1) records V8
// block coverage for every page a test opens and writes one record per test
// (scripts/impact-collect.mjs). `merge` combines the records of a full run
// into the map PR selection reads:
//
//   { version, commit, generatedAt,
//     specs:     [spec files that recorded coverage],
//     tests:     [{ id, spec, title, location }]     index = test number
//     files:     { "src/x.ts": [specs that loaded it] }      (file level)
//     exercised: { "src/x.ts": [specs where a function in it ran] }
//     assets:    { "static/x.png": [specs whose pages fetched it] }
//     lines:     { "src/x.ts": { blob, aligned, mapped, blocks, tests, cover } }
//     sets:      [test sets, encoded by encodeSet] }
//
// files/exercised/assets are the file-level layer the selector uses today.
// lines is the per-test, original-line layer (hunk/test-level selection):
//   blob     git blob id of the file the run served (line numbers hold only
//            for that version), aligned: its source map embedded that text
//   mapped   original lines with any generated code, as [start, end] runs
//   blocks   V8 function/block spans in original lines
//   tests    set index: tests that loaded the file
//   cover    [[start, end, set index], ...]: tests that covered those lines
// A loaded module counts on every spec that evaluated it, including at
// startup; `exercised` excludes modules whose only code that ran was their
// top level.
//
// Usage:
//   node scripts/impact-coverage.mjs merge --out map.json [--commit SHA] [--reports <dir>] <record dir>...
//     --reports: Playwright JSON reports of the run; specs with an executed
//     test that left no record are marked incomplete.
//   node scripts/impact-coverage.mjs stats <map.json>

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAP_VERSION = 1;

/**
 * The oldest map PR selection trusts. The map is regenerated nightly on dev;
 * 72 hours tolerates two failed nightlies. Dev pushes still run every spec,
 * so a dependency that a stale map misses is caught when the PR lands.
 */
export const MAX_MAP_AGE_HOURS = 72;

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
  if (!path.startsWith("/src/") || path.includes("/node_modules/") || path.includes("/../")) return null;
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

// --- line runs and test sets ---------------------------------------------

/** @param {Iterable<number>} lines @returns {Array<[number, number]>} */
export function toRuns(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  /** @type {Array<[number, number]>} */
  const runs = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] + 1 === n) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/** @param {Array<[number, number]>} runs @returns {number[]} */
export function fromRuns(runs) {
  const out = [];
  for (const [a, b] of runs) for (let n = a; n <= b; n++) out.push(n);
  return out;
}


/**
 * Encode a set of test indices: "l" + comma list when short, else "b" +
 * base64 bitset over `size` tests.
 * @param {number[]} indices
 * @param {number} size
 */
export function encodeSet(indices, size) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const list = "l" + sorted.join(",");
  const bits = Buffer.alloc(Math.ceil(size / 8));
  for (const i of sorted) bits[i >> 3] |= 1 << (i & 7);
  const bitset = "b" + bits.toString("base64");
  return list.length <= bitset.length ? list : bitset;
}

/** @param {string} encoded @returns {number[]} */
export function decodeSet(encoded) {
  if (typeof encoded !== "string") throw new Error("test set is not a string");
  if (encoded.startsWith("l")) return encoded.length === 1 ? [] : encoded.slice(1).split(",").map(Number);
  if (encoded.startsWith("b")) {
    const bits = Buffer.from(encoded.slice(1), "base64");
    const out = [];
    for (let i = 0; i < bits.length * 8; i++) if (bits[i >> 3] & (1 << (i & 7))) out.push(i);
    return out;
  }
  throw new Error("unknown test set encoding");
}

// --- merge ----------------------------------------------------------------

/**
 * @typedef {{ v?: number, id: string, spec: string, title?: string[], location?: string,
 *   loaded: string[], exercised: string[], lines?: Record<string, Array<[number, number]>>,
 *   requests?: string[], retry?: number, status?: string, failures?: string[] }} TestRecord
 *   status: Playwright's status for that attempt; failures: what the
 *   collector could not record (a page closed early, a CDP error).
 * @typedef {import("./impact-collect.mjs").FileMeta} FileMeta
 * @typedef {{ blob: string | null, aligned: boolean, mapped: Array<[number, number]>,
 *   blocks: Array<[number, number]>, tests: number, cover: Array<[number, number, number]> }} FileLines
 * @typedef {{ version: number, commit: string, generatedAt: string, specs: string[], incomplete?: string[],
 *   tests: Array<{ id: string, spec: string, title: string[], location: string }>,
 *   files: Record<string, string[]>, exercised: Record<string, string[]>, assets: Record<string, string[]>,
 *   lines: Record<string, FileLines>, sets: string[] }} ImpactMap
 */

/**
 * Merge per-test records (every attempt of every test) and per-file metas.
 * A file served in more than one version during the run keeps line data only
 * when all versions agree; otherwise its lines entry is dropped (file level
 * still applies).
 * @param {TestRecord[]} records
 * @param {FileMeta[]} metas
 * @param {{ commit?: string, generatedAt?: string, expected?: Array<{ id: string, spec: string }> }} [meta]
 *   expected: the tests the run executed (from its JSON reports). A spec with
 *   an executed test that left no record is incomplete: it is listed in
 *   `incomplete` and left out of `specs`, so selection always runs it. So is
 *   a spec with a test whose final attempt did not pass (it stopped part-way,
 *   so its coverage is truncated) or whose collector reported a failure.
 * @returns {ImpactMap}
 */
export function mergeImpact(records, metas, { commit = "unknown", generatedAt = new Date().toISOString(), expected = [] } = {}) {
  /** @type {Map<string, number>} */
  const testIndex = new Map();
  /** @type {ImpactMap["tests"]} */
  const tests = [];
  for (const r of records) {
    if (testIndex.has(r.id)) continue;
    testIndex.set(r.id, tests.length);
    tests.push({ id: r.id, spec: r.spec, title: r.title ?? [], location: r.location ?? r.spec });
  }
  /** @type {Map<string, Map<string, Set<string>>>} */
  const layers = new Map([["files", new Map()], ["exercised", new Map()], ["assets", new Map()]]);
  /** @param {string} layer @param {string} file @param {string} spec */
  const add = (layer, file, spec) => {
    const m = /** @type {Map<string, Set<string>>} */ (layers.get(layer));
    let set = m.get(file);
    if (!set) m.set(file, (set = new Set()));
    set.add(spec);
  };
  /** @type {Map<string, Set<number>>} */
  const fileTests = new Map();
  /** @type {Map<string, Map<number, Set<number>>>} */
  const lineTests = new Map();
  for (const r of records) {
    const t = /** @type {number} */ (testIndex.get(r.id));
    for (const f of r.loaded) {
      add("files", f, r.spec);
      let s = fileTests.get(f);
      if (!s) fileTests.set(f, (s = new Set()));
      s.add(t);
    }
    for (const f of r.exercised) add("exercised", f, r.spec);
    for (const f of r.requests ?? []) add("assets", f, r.spec);
    for (const [f, runs] of Object.entries(r.lines ?? {})) {
      let byLine = lineTests.get(f);
      if (!byLine) lineTests.set(f, (byLine = new Map()));
      for (const [a, b] of runs) for (let n = a; n <= b; n++) {
        let s = byLine.get(n);
        if (!s) byLine.set(n, (s = new Set()));
        s.add(t);
      }
    }
  }

  /** @type {Map<string, number>} */
  const setIndex = new Map();
  /** @type {string[]} */
  const sets = [];
  /** @param {Iterable<number>} members */
  const intern = (members) => {
    const enc = encodeSet([...members], tests.length);
    let i = setIndex.get(enc);
    if (i === undefined) { i = sets.length; sets.push(enc); setIndex.set(enc, i); }
    return i;
  };

  /** @type {Map<string, FileMeta[]>} */
  const metasByPath = new Map();
  for (const m of metas) {
    const list = metasByPath.get(m.path) ?? [];
    list.push(m);
    metasByPath.set(m.path, list);
  }
  /** @type {Record<string, FileLines>} */
  const lines = {};
  for (const file of [...lineTests.keys()].sort()) {
    const versions = metasByPath.get(file) ?? [];
    const blobs = new Set(versions.map((m) => m.blob));
    if (versions.length === 0 || blobs.size !== 1) continue;
    const meta = versions[0];
    const byLine = /** @type {Map<number, Set<number>>} */ (lineTests.get(file));
    /** @type {Array<[number, number, number]>} */
    const cover = [];
    /** @type {[number, number, number] | null} */
    let run = null;
    for (const n of [...byLine.keys()].sort((a, b) => a - b)) {
      const idx = intern(/** @type {Set<number>} */ (byLine.get(n)));
      if (run && run[1] + 1 === n && run[2] === idx) run[1] = n;
      else { run = [n, n, idx]; cover.push(run); }
    }
    lines[file] = {
      blob: meta.blob,
      aligned: versions.every((m) => m.aligned),
      mapped: meta.mapped,
      blocks: meta.blocks,
      tests: intern(fileTests.get(file) ?? []),
      cover,
    };
  }
  /** @param {Map<string, Set<string>>} m */
  const plain = (m) => Object.fromEntries([...m.keys()].sort().map((k) => [k, [...(m.get(k) ?? [])].sort()]));
  /** @type {Map<string, TestRecord>} */
  const finalAttempt = new Map();
  for (const r of records) {
    const prev = finalAttempt.get(r.id);
    if (!prev || (r.retry ?? 0) >= (prev.retry ?? 0)) finalAttempt.set(r.id, r);
  }
  const truncated = [
    ...[...finalAttempt.values()].filter((r) => r.status !== undefined && r.status !== "passed" && r.status !== "skipped"),
    ...records.filter((r) => (r.failures ?? []).length > 0),
  ].map((r) => r.spec);
  const incomplete = [...new Set([...expected.filter((t) => !testIndex.has(t.id)).map((t) => t.spec), ...truncated])].sort();
  return {
    version: MAP_VERSION,
    commit,
    generatedAt,
    specs: [...new Set(tests.map((t) => t.spec))].filter((s) => !incomplete.includes(s)).sort(),
    incomplete,
    tests,
    files: plain(/** @type {Map<string, Set<string>>} */ (layers.get("files"))),
    exercised: plain(/** @type {Map<string, Set<string>>} */ (layers.get("exercised"))),
    assets: plain(/** @type {Map<string, Set<string>>} */ (layers.get("assets"))),
    lines,
    sets,
  };
}

/**
 * The tests a Playwright JSON report says ran (any status but skipped), with
 * their spec paths relative to the repository (testDir is e2e/).
 * @param {any} report
 * @param {string} [testDir]
 * @returns {Array<{ id: string, spec: string }>}
 */
export function expectedTests(report, testDir = "e2e") {
  /** @type {Array<{ id: string, spec: string }>} */
  const out = [];
  /** @param {any} suite */
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const ran = (spec.tests ?? []).some((/** @type {any} */ t) =>
        (t.results ?? []).some((/** @type {any} */ r) => r.status !== "skipped"));
      if (ran) out.push({ id: spec.id, spec: `${testDir}/${spec.file}` });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return out;
}

// --- load ------------------------------------------------------------------

/** @param {unknown} v */
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
/** @param {unknown} v */
const isListRecord = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isStringArray);

/**
 * Parse and validate a map for selection. Returns the map, or the reason
 * selection must fall back without it.
 * @param {string | null | undefined} text
 * @param {{ now?: Date, maxAgeHours?: number }} [options]
 * @returns {{ map: ImpactMap } | { error: string }}
 */
export function loadImpactMap(text, { now = new Date(), maxAgeHours = MAX_MAP_AGE_HOURS } = {}) {
  if (text === null || text === undefined || text === "") return { error: "no impact map" };
  let data;
  try { data = JSON.parse(text); } catch { return { error: "impact map is not valid JSON" }; }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "impact map is not an object" };
  if (data.version !== MAP_VERSION) return { error: `impact map version ${data.version} is not ${MAP_VERSION}` };
  if (!isStringArray(data.specs) || !isListRecord(data.files) || !isListRecord(data.exercised) || !isListRecord(data.assets)) {
    return { error: "impact map is malformed" };
  }
  if (data.specs.length === 0 || Object.keys(data.files).length === 0) return { error: "impact map is empty" };
  if (typeof data.generatedAt !== "string") return { error: "impact map has no valid generatedAt" };
  const generated = Date.parse(data.generatedAt);
  if (Number.isNaN(generated)) return { error: "impact map has no valid generatedAt" };
  const ageHours = (now.getTime() - generated) / 3_600_000;
  if (ageHours > maxAgeHours) return { error: `impact map is ${Math.round(ageHours)}h old (limit ${maxAgeHours}h)` };
  if (ageHours < -1) return { error: "impact map generatedAt is in the future" };
  return { map: data };
}

// --- CLI -------------------------------------------------------------------

/** @param {string} p @returns {string[]} */
function jsonFiles(p) {
  if (statSync(p).isDirectory()) return readdirSync(p).flatMap((n) => jsonFiles(join(p, n)));
  return p.endsWith(".json") ? [p] : [];
}

/**
 * How many specs each file maps to under each file-level rule.
 * @param {Pick<ImpactMap, "specs" | "files" | "exercised">} map
 */
export function mapStats(map) {
  const specCount = map.specs.length;
  /** @param {Record<string, string[]>} rec */
  const dist = (rec) => {
    const counts = Object.values(rec).map((l) => l.length).sort((a, b) => a - b);
    const pick = (/** @type {number} */ q) => counts.length ? counts[Math.min(counts.length - 1, Math.floor(q * counts.length))] : 0;
    return {
      files: counts.length,
      median: pick(0.5),
      p90: pick(0.9),
      mean: counts.length ? +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1) : 0,
      nearlyAll: counts.filter((c) => c >= 0.9 * specCount).length,
    };
  };
  const loadedOnly = Object.keys(map.files).filter((f) => !map.exercised[f]);
  return { specs: specCount, loaded: dist(map.files), exercised: dist(map.exercised), loadedOnlyFiles: loadedOnly.length };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "merge") {
    let out = null;
    let commit = process.env.GITHUB_SHA ?? "unknown";
    const inputs = [];
    const reports = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--out") out = rest[++i];
      else if (rest[i] === "--commit") commit = rest[++i];
      else if (rest[i] === "--reports") reports.push(rest[++i]);
      else inputs.push(rest[i]);
    }
    if (!out || inputs.length === 0) throw new Error("usage: merge --out map.json [--commit SHA] <record dir>...");
    /** @type {TestRecord[]} */
    const records = [];
    /** @type {FileMeta[]} */
    const metas = [];
    /** @type {Array<{ id: string, spec: string }>} */
    const expected = [];
    const reportFiles = new Set(reports.flatMap(jsonFiles));
    for (const file of inputs.flatMap(jsonFiles)) {
      if (reportFiles.has(file)) continue;
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (typeof data.path === "string" && "blob" in data) metas.push(data);
      else if (typeof data.spec === "string" && typeof data.id === "string") records.push(data);
    }
    for (const file of reportFiles) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(data.suites) && data.config) expected.push(...expectedTests(data));
    }
    if (records.length === 0) throw new Error("no coverage records found");
    const map = mergeImpact(records, metas, { commit, expected });
    if (map.incomplete?.length) process.stderr.write(`[impact-coverage] incomplete (always selected): ${map.incomplete.join(" ")}\n`);
    writeFileSync(out, JSON.stringify(map) + "\n");
    process.stderr.write(`[impact-coverage] ${records.length} records, ${map.tests.length} tests, ${map.sets.length} test sets: ${JSON.stringify(mapStats(map))}\n`);
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
