// impact-select.mjs — which browser specs a diff reaches, from the test-impact
// map (#1368). Pure: the map, the changed files' texts and hunks in; specs,
// tests and escalation reasons out. scripts/e2e-affected.mjs wires it in.
//
// Two layers, both conservative (over-selection is safe; silent
// under-selection is not):
//
// file level   a changed module selects every spec that loaded it.
//
// function level (default; method-level test-impact analysis)
//              each diff hunk selects the tests that entered the innermost
//              function enclosing it on the old (merge-base) side: those
//              that covered any line of its body after the line its body
//              starts on. A hunk that touches a function's header or closing
//              line, sits outside every function (module level, Svelte
//              markup and styles), or lands in a function the new side
//              reshapes, selects every test that loaded the file. Only
//              syntax-level proofs select nothing: comments, blank lines and
//              type syntax with no generated code on the old side, and a new
//              import binding (unmentioned local name) of a module every
//              loader already evaluates. Removing or reordering imports
//              changes evaluation and selects every loader.
//              A hunk whose function no test entered (a WebKit-, Tauri- or
//              timing-only path) falls back to the file level and is
//              reported in `zeroCoverage`, so WebKit can run in full.
//              The function level needs the map's line data for exactly the
//              old text: the same git blob, or a translation through the
//              diff from the map's commit. Otherwise that file uses the file
//              level.
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
  return { fileLines, coveredIn };
}

/**
 * @param {{ impact: ImpactMap, changed: ChangedFile[], level?: "file" | "hunk", ts?: any,
 *   exists?: (path: string) => boolean }} input
 *   level: "hunk" is the function level described above.
 *   exists: whether a repo path exists (to resolve import specifiers).
 * @returns {ImpactSelection}
 */
export function selectFromImpact({ impact, changed, level = "hunk", ts = null, exists = () => false }) {
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
    const headText = /** @type {string} */ (file.headText);
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

    // Removing an import (Svelte keeps unused value imports, so its module
    // may no longer evaluate) or reordering imports (ESM evaluation order)
    // reaches every test that loads this file.
    const order = (/** @type {import("./impact-regions.mjs").SourceFacts} */ f) =>
      [...new Set(f.imports.filter((i) => !i.erased).map((i) => i.specifier))];
    const before = order(baseFacts);
    const after = order(headFacts);
    if (before.some((s) => !after.includes(s)) || after.filter((s) => before.includes(s)).join("\n") !== before.join("\n")) {
      fileLevel(path);
      continue;
    }
    /**
     * Whether the edits to `specifier`'s imports only add bindings: no
     * side-effect import or re-export of it, no binding dropped, each new
     * binding under a local name the old file never mentions (so nothing
     * existing, a global included, resolves to it), and its module already
     * evaluated by every test that loads this file.
     */
    const onlyNewBindings = (/** @type {string} */ specifier) => {
      const of = (/** @type {import("./impact-regions.mjs").SourceFacts} */ f) => f.imports.filter((i) => i.specifier === specifier);
      const was = of(baseFacts);
      const now = of(headFacts);
      if ([...was, ...now].some((i) => i.bindings === null)) return false;
      const set = (/** @type {import("./impact-regions.mjs").ImportFact[]} */ list) => new Set(list.flatMap((i) => i.bindings ?? []));
      const wasSet = set(was);
      const nowSet = set(now);
      for (const b of wasSet) if (!nowSet.has(b)) return false;
      for (const b of nowSet) if (!wasSet.has(b) && mentions(baseText, b.slice(0, b.indexOf("=")))) return false;
      return alreadyLoaded(specifier);
    };
    /** An old line whose change cannot alter execution by itself. */
    const inertBase = (/** @type {number} */ n) => {
      const region = baseFacts.lines[n - 1] ?? { kind: "code" };
      if (NO_RUNTIME.has(region.kind)) {
        const m = toMap(n);
        // A line edited since the map's commit has no source-map evidence;
        // the AST alone is proof only outside Svelte markup.
        return m === null ? !path.endsWith(".svelte") : !lines.mapped.has(m);
      }
      return region.kind === "import" && Boolean(region.specifier) && onlyNewBindings(/** @type {string} */ (region.specifier));
    };
    /** A new line that adds no execution of its own. */
    const inertHead = (/** @type {number} */ n) => {
      const region = headFacts.lines[n - 1];
      if (!region || NO_RUNTIME.has(region.kind)) return true;
      return region.kind === "import" && Boolean(region.specifier) && onlyNewBindings(/** @type {string} */ (region.specifier));
    };

    const baseLines = baseText.split("\n");
    const headLines = headText.split("\n");
    /**
     * The innermost function whose body strictly contains lines [a, b]
     * (an insertion after line a when b < a): not its header lines, not its
     * closing line.
     * @param {import("./impact-regions.mjs").FunctionSpan[]} functions
     */
    const innermost = (functions, /** @type {number} */ a, /** @type {number} */ b) => {
      const inside = (/** @type {import("./impact-regions.mjs").FunctionSpan} */ f) =>
        b < a ? f.body <= a && a < f.end : f.body < a && b < f.end;
      /** @type {import("./impact-regions.mjs").FunctionSpan | null} */
      let best = null;
      for (const f of functions) if (inside(f) && (!best || f.end - f.start < best.end - best.start)) best = f;
      return best;
    };
    const header = (/** @type {string[]} */ text, /** @type {import("./impact-regions.mjs").FunctionSpan} */ f) =>
      text.slice(f.start - 1, f.body).join("\n");

    let fellBack = false;
    /** @type {Set<number>} */
    const selected = new Set();
    for (const h of file.hunks) {
      const removed = Array.from({ length: h.baseCount }, (_, i) => h.baseStart + i);
      const added = Array.from({ length: h.headCount }, (_, i) => h.headStart + i);
      // Proof of no runtime effect: nothing but inert lines on either side.
      if (removed.every(inertBase) && added.every(inertHead)) continue;
      const fn = innermost(baseFacts.functions, h.baseStart, h.baseStart + h.baseCount - 1);
      const headFn = innermost(headFacts.functions, h.headStart, h.headStart + h.headCount - 1);
      // The same function on both sides: same header, same closing line.
      const same = fn && headFn && header(baseLines, fn) === header(headLines, headFn) &&
        baseLines[fn.end - 1] === headLines[headFn.end - 1];
      const from = fn ? toMap(fn.body) : null;
      const to = fn ? toMap(fn.end) : null;
      if (!fn || !same || from === null || to === null || to <= from) { fellBack = true; break; }
      const entered = index.coveredIn(path, from + 1, to);
      if (entered.size === 0) {
        out.zeroCoverage.push(`${path}:${h.baseStart}`);
        fellBack = true;
        break;
      }
      for (const t of entered) selected.add(t);
    }
    if (fellBack) { fileLevel(path); continue; }
    out.hunkLevel.push(path);
    addTests(selected);
  }
  return out;
}

/**
 * Add the tests whose behaviour may differ from the map: those that ran code
 * changed between the map's commit and the merge base (`drift`, selected
 * like a PR over that diff), and every spec whose own definition changed
 * since then (`driftSpecs`). For them the map's coverage is out of date, so
 * they run whatever the PR changes. Drift that cannot be placed selects ALL.
 * The drift's unexecuted hunks do not mark the PR's change as WebKit-only.
 * @param {ImpactSelection} pr
 * @param {ImpactSelection} drift
 * @param {Iterable<string>} driftSpecs
 * @returns {ImpactSelection}
 */
export function withDrift(pr, drift, driftSpecs) {
  return {
    all: [...pr.all, ...drift.all.map((r) => `since the impact map's commit: ${r}`)],
    specs: new Set([...pr.specs, ...drift.specs, ...driftSpecs]),
    tests: new Set([...pr.tests, ...drift.tests]),
    zeroCoverage: pr.zeroCoverage,
    fileLevel: pr.fileLevel,
    hunkLevel: pr.hunkLevel,
  };
}
