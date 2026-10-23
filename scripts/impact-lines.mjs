// impact-lines.mjs — V8 block coverage to original source lines (#1368).
//
// The Vite dev server serves every TypeScript and Svelte module with an
// inline source map (esbuild and the Svelte compiler both emit one). For one
// script's coverage this maps each generated mapping segment to the original
// line it came from and reports:
//   covered  original lines with a segment whose innermost V8 range ran
//   mapped   original lines with any generated code (static per file version)
//   blocks   the V8 function/block ranges as original [startLine, endLine]
//            spans (static per file version), for the PR-2 hunk selector's
//            "smallest enclosing block" rule
// Lines are 1-based. Ranges are emitted as sorted inclusive [start, end] runs.

import { decode } from "@jridgewell/sourcemap-codec";
import { toRuns } from "./impact-coverage.mjs";

const INLINE_MAP = /\/\/[#@] sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/;

/**
 * @param {string} source
 * @returns {{ sources: string[], sourcesContent?: (string | null)[], mappings: string } | null}
 */
export function inlineSourceMap(source) {
  const m = INLINE_MAP.exec(source);
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); } catch { return null; }
}

/**
 * @typedef {import("./impact-coverage.mjs").ScriptCoverage} ScriptCoverage
 * @typedef {{ covered: Array<[number, number]>, mapped: Array<[number, number]>,
 *   blocks: Array<[number, number]>, sourceText: string | null }} ScriptLines
 */

/**
 * Original-line coverage of one script, or null when it has no usable inline
 * source map (a Svelte style module, a plain asset module).
 * @param {ScriptCoverage & { source: string }} script
 * @returns {ScriptLines | null}
 */
export function scriptLines(script) {
  const map = inlineSourceMap(script.source);
  if (!map || map.sources?.length !== 1) return null;
  let decoded;
  try { decoded = decode(map.mappings); } catch { return null; }
  const source = script.source;
  /** @type {number[]} */
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);

  // Segments as [generated offset, original line (1-based)], by offset.
  /** @type {Array<[number, number]>} */
  const segments = [];
  decoded.forEach((line, genLine) => {
    const base = lineStarts[genLine];
    if (base === undefined) return;
    for (const seg of line) if (seg.length >= 4) segments.push([base + seg[0], /** @type {number} */ (seg[2]) + 1]);
  });
  segments.sort((a, b) => a[0] - b[0]);

  // V8 ranges nest; the innermost range containing an offset decides its count.
  const ranges = script.functions.flatMap((fn) => fn.ranges ?? [])
    .map((r) => ({ start: r.startOffset, end: r.endOffset, count: r.count }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  /** @type {Set<number>} */
  const covered = new Set();
  /** @type {Set<number>} */
  const mapped = new Set();
  /** @type {typeof ranges} */
  const stack = [];
  let next = 0;
  for (const [offset, line] of segments) {
    mapped.add(line);
    while (next < ranges.length && ranges[next].start <= offset) {
      const r = ranges[next++];
      while (stack.length && stack[stack.length - 1].end <= r.start) stack.pop();
      stack.push(r);
    }
    while (stack.length && stack[stack.length - 1].end <= offset) stack.pop();
    // No enclosing range: top-level code of an evaluated script ran.
    const count = stack.length ? stack[stack.length - 1].count : 1;
    if (count > 0) covered.add(line);
  }

  // Block spans in original lines: the first and last segment inside each range.
  const lineAtOrAfter = (/** @type {number} */ offset) => {
    let lo = 0, hi = segments.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (segments[mid][0] < offset) lo = mid + 1; else hi = mid; }
    return lo;
  };
  /** @type {Map<string, [number, number]>} */
  const blocks = new Map();
  for (const r of ranges) {
    const first = lineAtOrAfter(r.start);
    const last = lineAtOrAfter(r.end) - 1;
    if (first > last) continue;
    let lo = Infinity, hi = -Infinity;
    for (let i = first; i <= last; i++) { lo = Math.min(lo, segments[i][1]); hi = Math.max(hi, segments[i][1]); }
    blocks.set(`${lo}:${hi}`, [lo, hi]);
  }
  return {
    covered: toRuns(covered),
    mapped: toRuns(mapped),
    blocks: [...blocks.values()].sort((a, b) => a[0] - b[0] || b[1] - a[1]),
    sourceText: map.sourcesContent?.[0] ?? null,
  };
}
