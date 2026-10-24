// impact-bundle.mjs — V8 coverage of a bundled chunk to original source lines
// (#1386).
//
// Dev pushes record the test-impact map on the shared browser-test bundle
// (#1381), whose chunks combine many source modules. Each chunk has a hidden
// source map (`<chunk>.js.map`, E2E_BROWSER_BUILD=1). This maps every
// generated segment to its original file and line and reports, per file, the
// same facts scripts/impact-lines.mjs reports for one dev-server module:
//   covered  original lines with a segment whose innermost V8 range ran
//   mapped   original lines with any generated code in this chunk
//   blocks   V8 function ranges as original [startLine, endLine] spans
//   ran      whether a function other than the chunk's top level ran there
//   loaded   whether the chunk evaluated: Rollup runs a chunk's modules as
//            one script, so each file in it was evaluated, as a dev-server
//            module is, even when only uncalled functions of it remain
// Lines are 1-based; ranges are sorted inclusive [start, end] runs.

import { decode } from "@jridgewell/sourcemap-codec";
import { posix } from "node:path";
import { toRuns } from "./impact-coverage.mjs";

/**
 * SvelteKit writes client chunks under this directory before adapter-static
 * copies them to `build/`; a chunk map's `sources` are relative to it.
 */
export const CLIENT_OUTPUT_DIR = ".svelte-kit/output/client";

/**
 * Repository path of one source a chunk map names, or null for anything
 * outside `src/` (node_modules, SvelteKit's generated runtime, virtual ids).
 * @param {string} chunkPath chunk path inside the build, e.g. `_app/immutable/chunks/x.js`
 * @param {string} source an entry of the map's `sources`
 * @param {string} [sourceRoot] the map's `sourceRoot`
 * @returns {string | null}
 */
export function bundleSourcePath(chunkPath, source, sourceRoot = "") {
  if (!source || /^[a-z][\w+.-]*:/i.test(source) || source.startsWith("\0")) return null;
  const from = posix.join(CLIENT_OUTPUT_DIR, posix.dirname(chunkPath), sourceRoot);
  const path = posix.normalize(posix.join(from, source.split("?")[0]));
  if (path.startsWith("../") || path.startsWith("/") || !path.startsWith("src/")) return null;
  if (path.split("/").includes("node_modules")) return null;
  return path;
}

/**
 * @typedef {{ startOffset: number, endOffset: number, count: number }} Range
 * @typedef {{ ranges: Range[] }} CoverageFunction
 * @typedef {{ covered: Array<[number, number]>, mapped: Array<[number, number]>,
 *   blocks: Array<[number, number]>, ran: boolean, loaded: boolean, sourceText: string | null }} FileLines
 * @typedef {{ sources: string[], sourceRoot?: string, sourcesContent?: (string | null)[], mappings: string }} SourceMap
 */

/**
 * Static, per-chunk mapping data: segments as generated offset → (file index,
 * original line), sorted by offset. Computed once per chunk and reused for
 * every test.
 * @param {string} chunkPath
 * @param {string} code the chunk's generated source
 * @param {SourceMap} map
 */
export function chunkSegments(chunkPath, code, map) {
  /** @type {number[]} */
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const paths = map.sources.map((s) => bundleSourcePath(chunkPath, s, map.sourceRoot));
  const decoded = decode(map.mappings);
  /** @type {number[]} */
  const offsets = [];
  /** @type {number[]} */
  const files = [];
  /** @type {number[]} */
  const lines = [];
  decoded.forEach((line, genLine) => {
    const base = lineStarts[genLine];
    if (base === undefined) return;
    for (const seg of line) {
      if (seg.length < 4 || paths[/** @type {number} */ (seg[1])] === null) continue;
      offsets.push(base + seg[0]);
      files.push(/** @type {number} */ (seg[1]));
      lines.push(/** @type {number} */ (seg[2]) + 1);
    }
  });
  const order = offsets.map((_, i) => i).sort((a, b) => offsets[a] - offsets[b]);
  return {
    paths,
    sourcesContent: map.sourcesContent ?? [],
    offsets: Int32Array.from(order, (i) => offsets[i]),
    files: Int32Array.from(order, (i) => files[i]),
    lines: Int32Array.from(order, (i) => lines[i]),
  };
}

/**
 * Whether a reported chunk evaluated: its top-level function (the range at
 * offset 0 spanning the most) ran. A chunk V8 reports with no top-level
 * function was compiled for evaluation.
 * @param {CoverageFunction[]} functions
 */
export function chunkEvaluated(functions) {
  let top = null;
  for (const fn of functions) {
    const r = fn.ranges?.[0];
    if (r && r.startOffset === 0 && (!top || r.endOffset > top.endOffset)) top = r;
  }
  return !top || top.count > 0;
}

/**
 * Per-file original lines one chunk's coverage reaches.
 * @param {ReturnType<typeof chunkSegments>} chunk
 * @param {CoverageFunction[]} functions V8 coverage of this chunk (function or block ranges)
 * @param {{ blocks?: boolean }} [options] compute function spans (static per
 *   chunk version, so callers ask once and cache them)
 * @returns {Map<string, FileLines>}
 */
export function chunkCoverage(chunk, functions, { blocks: withBlocks = true } = {}) {
  const ranges = functions.flatMap((fn) => fn.ranges ?? [])
    .map((r) => ({ start: r.startOffset, end: r.endOffset, count: r.count }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  // The chunk's top-level function spans the whole script.
  const top = ranges.length && ranges[0].start === 0 ? ranges[0] : null;
  const evaluated = chunkEvaluated(functions);
  /** @type {Map<number, { covered: Set<number>, mapped: Set<number>, ran: boolean }>} */
  const byFile = new Map();
  const entry = (/** @type {number} */ f) => {
    let e = byFile.get(f);
    if (!e) byFile.set(f, (e = { covered: new Set(), mapped: new Set(), ran: false }));
    return e;
  };
  /** @type {typeof ranges} */
  const stack = [];
  let next = 0;
  const { offsets, files, lines } = chunk;
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    const e = entry(files[i]);
    e.mapped.add(lines[i]);
    while (next < ranges.length && ranges[next].start <= offset) {
      const r = ranges[next++];
      while (stack.length && stack[stack.length - 1].end <= r.start) stack.pop();
      stack.push(r);
    }
    while (stack.length && stack[stack.length - 1].end <= offset) stack.pop();
    const inner = stack[stack.length - 1];
    if ((inner ? inner.count : 1) > 0) {
      e.covered.add(lines[i]);
      if (inner && inner !== top) e.ran = true;
    }
  }

  // Function spans per file: the lowest and highest original line of the
  // segments inside each range that belong to that file.
  /** @type {Map<number, Map<string, [number, number]>>} */
  const blocks = new Map();
  const firstAtOrAfter = (/** @type {number} */ offset) => {
    let lo = 0, hi = offsets.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] < offset) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const r of withBlocks ? ranges : []) {
    if (r === top) continue;
    const first = firstAtOrAfter(r.start);
    const last = firstAtOrAfter(r.end) - 1;
    /** @type {Map<number, [number, number]>} */
    const spans = new Map();
    for (let i = first; i <= last; i++) {
      const span = spans.get(files[i]);
      if (span) { span[0] = Math.min(span[0], lines[i]); span[1] = Math.max(span[1], lines[i]); }
      else spans.set(files[i], [lines[i], lines[i]]);
    }
    for (const [f, span] of spans) {
      let m = blocks.get(f);
      if (!m) blocks.set(f, (m = new Map()));
      m.set(`${span[0]}:${span[1]}`, span);
    }
  }

  /** @type {Map<string, FileLines>} */
  const out = new Map();
  for (const [f, e] of byFile) {
    const path = chunk.paths[f];
    if (!path) continue;
    out.set(path, {
      covered: toRuns(e.covered),
      mapped: toRuns(e.mapped),
      blocks: [...(blocks.get(f)?.values() ?? [])].sort((a, b) => a[0] - b[0] || b[1] - a[1]),
      ran: e.ran,
      loaded: evaluated,
      sourceText: chunk.sourcesContent[f] ?? null,
    });
  }
  return out;
}
