// impact-select.mjs — which browser specs a diff reaches, from the test-impact
// map (#1368). Pure: the map, the changed files' texts and hunks in; specs,
// tests and escalation reasons out. scripts/e2e-affected.mjs wires it in.
//
// Two layers, both conservative (over-selection is safe; silent
// under-selection is not):
//
// file level   a changed module selects every spec that loaded it.
//
// hunk level   for each diff hunk on the old (merge-base) side, the tests
//              that covered any changed line. When the hunk also adds or
//              changes code that the old side cannot place (a pure
//              insertion, a replaced unmapped line), the tests that ran the
//              smallest enclosing V8 function/block. A hunk changes nothing
//              at runtime only with proof: its old lines have no generated
//              code in the source map AND the TypeScript parse of both sides
//              shows only comments, blank lines or type syntax. New code that
//              is only a binding (a new non-exported function whose name the
//              old file never mentions, or an import of a module every test
//              loading this file already evaluates) adds no execution of its
//              own; its callers are changed lines too.
//              A hunk that would select no test (code no test ran: a WebKit-,
//              Tauri- or timing-only branch) falls back to the file level and
//              is reported in `zeroCoverage`, so WebKit can run in full.
//              Hunk level needs the map's line data for exactly the old text:
//              the same git blob, or a translation through the diff from the
//              map's commit. Otherwise that file uses the file level.
//
// Escalations to every spec (`all`): a new file, a src file no spec loaded,
// an asset no spec fetched, an unclassifiable file.

import { decodeSet, fromRuns } from "./impact-coverage.mjs";
import { factsOf, resolveSpecifier } from "./impact-regions.mjs";

/**
 * @typedef {import("./impact-coverage.mjs").ImpactMap} ImpactMap
 * @typedef {import("./impact-regions.mjs").Hunk} Hunk
 * @typedef {{ path: string, status: "modified" | "added" | "deleted",
 *   baseText?: string | null, headText?: string | null, hunks?: Hunk[],
 *   baseBlob?: string | null, toMapLine?: ((line: number) => number | null) | null }} ChangedFile
 *   toMapLine: translate a merge-base line to the map commit's line (null:
 *   the line changed in between). Omitted when the blobs are equal.
 * @typedef {{ all: string[], specs: Set<string>, tests: Set<number>, zeroCoverage: string[],
 *   fileLevel: string[], hunkLevel: string[] }} ImpactSelection
 */

/**
 * Translate lines of one side of a diff to the other: `hunks` describe
 * from -> to (base = from, head = to). Lines inside a changed range map to
 * null.
 * @param {Hunk[]} hunks
 * @returns {(line: number) => number | null} from-line -> to-line
 */
export function lineTranslator(hunks) {
  const sorted = [...hunks].sort((a, b) => a.baseStart - b.baseStart);
  return (line) => {
    let delta = 0;
    for (const h of sorted) {
      const firstChanged = h.baseCount === 0 ? h.baseStart + 1 : h.baseStart;
      if (line < firstChanged) break;
      if (h.baseCount > 0 && line < h.baseStart + h.baseCount) return null;
      delta += h.headCount - h.baseCount;
    }
    return line + delta;
  };
}

/** Inverse view of hunks: swap the sides. @param {Hunk[]} hunks */
export const invertHunks = (hunks) =>
  hunks.map((h) => ({ baseStart: h.headStart, baseCount: h.headCount, headStart: h.baseStart, headCount: h.baseCount }));

const NO_RUNTIME = new Set(["trivia", "type"]);

/** Whether `text` mentions identifier `name` anywhere (code, strings, markup). */
export const mentions = (/** @type {string} */ text, /** @type {string} */ name) =>
  new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);

/**
 * @param {ImpactMap} impact
 */
function mapIndex(impact) {
  /** @type {Map<number, number[]>} */
  const decoded = new Map();
  const set = (/** @type {number} */ i) => {
    let s = decoded.get(i);
    if (!s) decoded.set(i, (s = decodeSet(impact.sets[i])));
    return s;
  };
  /** @type {Map<string, { mapped: Set<number>, cover: Array<[number, number, number]>, blocks: Array<[number, number]>, tests: number[] }>} */
  const files = new Map();
  const fileLines = (/** @type {string} */ path) => {
    let f = files.get(path);
    const entry = impact.lines?.[path];
    if (!f && entry) {
      f = { mapped: new Set(fromRuns(entry.mapped)), cover: entry.cover, blocks: entry.blocks, tests: set(entry.tests) };
      files.set(path, f);
    }
    return f ?? null;
  };
  /** Tests that covered any line in [a, b] (map coordinates). */
  const coveredIn = (/** @type {string} */ path, /** @type {number} */ a, /** @type {number} */ b) => {
    const f = fileLines(path);
    /** @type {Set<number>} */
    const out = new Set();
    if (!f) return out;
    for (const [s, e, i] of f.cover) {
      if (e < a) continue;
      if (s > b) break;
      for (const t of set(i)) out.add(t);
    }
    return out;
  };
  /**
   * Tests that ran the smallest block containing [a, b], or every loader for
   * the module's top level. A block's first line is its header (a function
   * signature, an `if` condition), which the enclosing code covers whether
   * or not the block itself ran, so only the lines after it count.
   */
  const enclosing = (/** @type {string} */ path, /** @type {number} */ a, /** @type {number} */ b) => {
    const f = fileLines(path);
    if (!f) return new Set();
    const outer = f.blocks.reduce((m, [s, e]) => [Math.min(m[0], s), Math.max(m[1], e)], [Infinity, -Infinity]);
    /** @type {[number, number] | null} */
    let best = null;
    for (const [s, e] of f.blocks) {
      if (s <= a && e >= b && (!best || e - s < best[1] - best[0])) best = [s, e];
    }
    if (!best || (best[0] === outer[0] && best[1] === outer[1])) return new Set(f.tests);
    return coveredIn(path, best[1] > best[0] ? best[0] + 1 : best[0], best[1]);
  };
  return { fileLines, coveredIn, enclosing };
}

/**
 * @param {{ impact: ImpactMap, changed: ChangedFile[], level?: "file" | "hunk", ts?: any,
 *   namespaceTargets?: Set<string>, exists?: (path: string) => boolean }} input
 *   namespaceTargets: repo files some module imports as a namespace
 *   (`import * as`, `export * from`, dynamic `import()`), whose new exports
 *   can be reached without a changed caller.
 * @returns {ImpactSelection}
 */
export function selectFromImpact({ impact, changed, level = "hunk", ts = null, namespaceTargets = new Set(), exists = () => false }) {
  const index = mapIndex(impact);
  /** @type {ImpactSelection} */
  const out = { all: [], specs: new Set(), tests: new Set(), zeroCoverage: [], fileLevel: [], hunkLevel: [] };
  const specOfTest = (/** @type {number} */ t) => impact.tests[t]?.spec;
  const addTests = (/** @type {Iterable<number>} */ tests) => {
    for (const t of tests) {
      out.tests.add(t);
      const spec = specOfTest(t);
      if (spec) out.specs.add(spec);
    }
  };
  const fileLevel = (/** @type {string} */ path) => {
    out.fileLevel.push(path);
    for (const s of impact.files[path] ?? []) out.specs.add(s);
    const f = index.fileLines(path);
    if (f) addTests(f.tests);
    else impact.tests.forEach((t, i) => { if ((impact.files[path] ?? []).includes(t.spec)) out.tests.add(i); });
  };

  for (const file of changed) {
    const { path } = file;
    const isModule = /\.(svelte|ts|js|mjs)$/.test(path);
    if (!isModule) {
      const specs = [...(impact.assets[path] ?? []), ...(impact.files[path] ?? [])];
      if (file.status === "added") { out.all.push(`new asset, not in the impact map: ${path}`); continue; }
      if (specs.length === 0) { out.all.push(`frontend asset no spec fetched or loaded: ${path}`); continue; }
      for (const s of specs) out.specs.add(s);
      impact.tests.forEach((t, i) => { if (specs.includes(t.spec)) out.tests.add(i); });
      continue;
    }
    const baseFacts = file.baseText != null ? factsOf(ts, path, file.baseText) : null;
    const headFacts = file.headText != null ? factsOf(ts, path, file.headText) : null;
    // A module with no runtime code on either side (types, comments) emits
    // nothing, wherever it is imported.
    const runtimeFree = (/** @type {import("./impact-regions.mjs").SourceFacts | null} */ f) =>
      f !== null && f.lines.every((l) => NO_RUNTIME.has(l.kind));
    if (ts && file.status === "modified" && runtimeFree(baseFacts) && runtimeFree(headFacts)) continue;
    if (file.status === "added") { out.all.push(`new file, not in the impact map: ${path}`); continue; }
    const loaders = impact.files[path];
    if (!loaders) { out.all.push(`src file absent from the impact map (no spec loaded it): ${path}`); continue; }
    if (loaders.length === 0) { out.all.push(`src file maps to no spec in the impact map: ${path}`); continue; }
    if (file.status === "deleted") { fileLevel(path); continue; }

    const lines = index.fileLines(path);
    const entry = impact.lines?.[path];
    const sameBlob = entry && file.baseBlob && entry.blob === file.baseBlob;
    const toMap = sameBlob ? (/** @type {number} */ n) => n : file.toMapLine ?? null;
    if (level === "file" || !ts || !lines || !entry?.aligned || !toMap || !baseFacts || !headFacts || !file.hunks) {
      fileLevel(path);
      continue;
    }

    const baseText = /** @type {string} */ (file.baseText);
    /** Every test loading this file already evaluates `specifier`'s module. */
    const alreadyLoaded = (/** @type {string} */ specifier) => {
      const target = resolveSpecifier(path, specifier, exists);
      if (!target) return false;
      const targetLines = index.fileLines(target);
      if (targetLines) {
        const loadedBy = new Set(targetLines.tests);
        return lines.tests.every((t) => loadedBy.has(t));
      }
      const targetSpecs = impact.files[target];
      return Boolean(targetSpecs && loaders.every((s) => targetSpecs.includes(s)));
    };
    const headImports = new Set(headFacts.lines.filter((l) => l.kind === "import" && l.specifier).map((l) => l.specifier));
    /** An old line whose change cannot alter execution by itself. */
    const inertRemoved = (/** @type {number} */ n) => {
      const region = baseFacts.lines[n - 1] ?? { kind: "code" };
      if (NO_RUNTIME.has(region.kind)) return !lines.mapped.has(/** @type {number} */ (toMap(n)));
      // An import whose module the new side still imports, and that every
      // loader already evaluates, only changes bindings.
      return region.kind === "import" && Boolean(region.specifier) && headImports.has(region.specifier) &&
        alreadyLoaded(/** @type {string} */ (region.specifier));
    };
    /** A new line that adds no execution of its own. */
    const inertAdded = (/** @type {number} */ n, /** @type {number} */ first, /** @type {number} */ last) => {
      const region = headFacts.lines[n - 1];
      if (!region || NO_RUNTIME.has(region.kind)) return true;
      if (region.kind === "import") return Boolean(region.specifier) && alreadyLoaded(/** @type {string} */ (region.specifier));
      // A wholly new declaration whose name the old file never mentions binds
      // a name nothing existing can call. Exports reachable through a
      // namespace import, and component exports, are excluded.
      return headFacts.declarations.some((d) =>
        d.start <= n && n <= d.end && d.start >= first && d.end <= last &&
        !(d.exported && (path.endsWith(".svelte") || namespaceTargets.has(path))) &&
        !mentions(baseText, d.name));
    };

    let fellBack = false;
    /** @type {Set<number>} */
    const selected = new Set();
    for (const h of file.hunks) {
      const removed = Array.from({ length: h.baseCount }, (_, i) => h.baseStart + i);
      if (removed.some((n) => toMap(n) === null)) { fellBack = true; break; }
      const lastAdded = h.headStart + h.headCount - 1;
      const addedCode = Array.from({ length: h.headCount }, (_, i) => h.headStart + i)
        .filter((n) => !inertAdded(n, h.headStart, lastAdded));
      const removedCode = removed.filter((n) => !inertRemoved(n));
      // Proof of no runtime effect: nothing but inert lines on either side.
      if (removedCode.length === 0 && addedCode.length === 0) continue;
      /** @type {Set<number>} */
      const hunkTests = new Set();
      const placed = removedCode.filter((n) => lines.mapped.has(/** @type {number} */ (toMap(n))));
      for (const n of placed) {
        const m = /** @type {number} */ (toMap(n));
        for (const t of index.coveredIn(path, m, m)) hunkTests.add(t);
      }
      // New code replacing placed old code runs where that code ran. A pure
      // insertion, or old code the source map cannot place, runs wherever the
      // smallest block around the change runs.
      if ((addedCode.length > 0 && placed.length === 0) || placed.length < removedCode.length) {
        if (h.baseCount === 0 && h.baseStart < 1) {
          for (const t of lines.tests) hunkTests.add(t);
        } else {
          const a = toMap(h.baseStart);
          const b = toMap(h.baseCount > 0 ? h.baseStart + h.baseCount - 1 : h.baseStart + 1);
          if (a === null || b === null) { fellBack = true; break; }
          for (const t of index.enclosing(path, a, b)) hunkTests.add(t);
        }
      }
      if (hunkTests.size === 0) {
        out.zeroCoverage.push(`${path}:${h.baseStart}`);
        fellBack = true;
        break;
      }
      for (const t of hunkTests) selected.add(t);
    }
    if (fellBack) { fileLevel(path); continue; }
    out.hunkLevel.push(path);
    addTests(selected);
  }
  return out;
}
