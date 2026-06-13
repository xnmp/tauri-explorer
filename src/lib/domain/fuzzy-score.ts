/**
 * Fuzzy string matching scorer for QuickOpen.
 * Modeled after fzy/VS Code — scores how well a query matches a candidate.
 *
 * Bonuses: prefix, path boundary (/), word boundary (_-. ), camelCase,
 *          consecutive runs, exact case.
 * Returns 0 if query is not a subsequence of candidate.
 */

import { basename } from "./path";

/** Fast subsequence check — all query chars must appear in order. */
function isSubsequence(query: string, candidate: string): boolean {
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Lowercase a string without changing its length.
 *
 * `String.prototype.toLowerCase` can change the number of UTF-16 code units
 * (e.g. Turkish "İ" → "i̇"), which would misalign indices between the folded
 * and original strings. Characters whose lowercase form has a different
 * length are kept as-is.
 */
function foldCase(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const lc = s[i].toLowerCase();
    out += lc.length === 1 ? lc : s[i];
  }
  return out;
}

/** Character bonus based on position context. */
function charBonus(candidate: string, ci: number): number {
  if (ci >= candidate.length) return 0; // defensive bounds check
  if (ci === 0) return 8; // prefix
  const prev = candidate[ci - 1];
  if (prev === "/" || prev === "\\") return 7; // path separator
  if (prev === "_" || prev === "-" || prev === "." || prev === " ") return 5; // word boundary
  const cur = candidate[ci];
  if (
    cur !== cur.toLowerCase() &&
    prev === prev.toLowerCase() &&
    prev !== prev.toUpperCase()
  ) return 3; // camelCase
  return 0;
}

/**
 * Score a query against a candidate string.
 * Returns 0 for no match, higher is better.
 */
export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 0;
  const q = foldCase(query);
  const c = foldCase(candidate);
  if (!isSubsequence(q, c)) return 0;

  const qLen = q.length;
  const cLen = c.length;

  // DP: score[qi][ci] = best score matching query[0..qi] ending at candidate[ci]
  // Use two rows to save memory
  let prev = new Float64Array(cLen);
  let prevConsec = new Float64Array(cLen);

  for (let qi = 0; qi < qLen; qi++) {
    const cur = new Float64Array(cLen);
    const curConsec = new Float64Array(cLen);
    let bestSoFar = -Infinity;

    for (let ci = qi; ci < cLen; ci++) {
      if (c[ci] !== q[qi]) {
        cur[ci] = bestSoFar;
        continue;
      }

      // Match bonus
      let bonus = 1 + charBonus(candidate, ci);
      if (query[qi] === candidate[ci]) bonus += 1; // exact case

      // Score from previous row (matching qi-1 somewhere before ci)
      let fromPrev = bonus;
      if (qi > 0 && ci > 0) {
        // Consecutive: previous query char matched at ci-1
        const consecutive = prevConsec[ci - 1] > 0
          ? prevConsec[ci - 1] + bonus + Math.min(5, qi) // growing run bonus
          : -Infinity;
        // Non-consecutive: best score from prev row up to ci-1
        const nonConsecutive = prev[ci - 1] + bonus;
        fromPrev = Math.max(consecutive, nonConsecutive);
      }

      curConsec[ci] = fromPrev;
      cur[ci] = Math.max(bestSoFar, fromPrev);
      bestSoFar = cur[ci];
    }

    prev = cur;
    prevConsec = curConsec;
  }

  // Best score is the max of the last row
  let best = 0;
  for (let ci = 0; ci < cLen; ci++) {
    if (prev[ci] > best) best = prev[ci];
  }

  // Slight preference for shorter candidates (exact name > longer path).
  // Clamp to a small positive epsilon so genuine matches in very long
  // candidates are never dropped by `score > 0` callers.
  return best > 0 ? Math.max(best - cLen * 0.02, 0.01) : 0;
}

/**
 * Score a query against a file path, weighting filename matches higher.
 * This is the main entry point for QuickOpen scoring.
 */
export function fuzzyScorePath(query: string, filePath: string): number {
  const name = basename(filePath);
  const nameScore = fuzzyScore(query, name);
  const pathScore = fuzzyScore(query, filePath);
  // Filename matches are 1.5x more valuable than path matches
  return Math.max(nameScore * 1.5, pathScore);
}
