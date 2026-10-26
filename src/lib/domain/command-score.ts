/**
 * Command-palette ranking. Pure; imported only by the lazily loaded
 * CommandPalette so it stays out of the startup bundle (the path scorer in
 * fuzzy-score.ts is startup-reachable).
 *
 * Commands use weighted field matching (label/category/shortcut/keyword
 * substrings), unlike file paths which use the fzy-style DP.
 */

/** Fields of a palette command relevant to matching (already lowercased). */
export interface CommandMatchFields {
  label: string;
  category: string;
  shortcut: string;
  /** Hidden lowercased synonyms (see command-keywords.ts); optional. */
  keywords?: readonly string[];
}

/** Cap frecency's contribution so it never dominates text relevance. */
export function commandFrecencyPoints(frecencyScore: number): number {
  return Math.min(30, Math.round(frecencyScore * 10));
}

/** Greedy subsequence check; returns the number of matched chars (=== query
 *  length when the whole query is a subsequence of text). */
function subsequenceLength(query: string, text: string): number {
  let qi = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) qi++;
  }
  return qi;
}

/**
 * Score a palette command against a lowercased query.
 *
 * Matching is token-based (VSCode-style): every whitespace-separated token
 * must be a subsequence of the label, or a substring of the category or
 * shortcut — so "git graph", "graph git" and "git" (as a category) all match
 * "Git: Show Commit Graph" regardless of word order. Whole-query substring
 * and prefix hits on the label rank highest.
 */
export function scoreCommand(
  fields: CommandMatchFields,
  queryLower: string,
  frecencyScore: number,
): number {
  const { label, category, shortcut } = fields;
  const keywords = fields.keywords ?? [];
  const tokens = queryLower.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let score = 0;

  // Exact match in label
  if (label.includes(queryLower)) {
    score += 100;
    // Bonus for starting with query
    if (label.startsWith(queryLower)) score += 50;
  }

  // Match in category
  if (category.includes(queryLower)) {
    score += 30;
  }

  // Match in shortcut
  if (shortcut.includes(queryLower)) {
    score += 40;
  }

  // Match in a hidden synonym: always below any label hit (label >= 100)
  if (keywords.some((k) => k.includes(queryLower))) {
    score += 25;
  }

  // Every token must land somewhere; label subsequence hits earn per-char
  // points so tighter label matches rank above category-only ones.
  for (const token of tokens) {
    const matched = subsequenceLength(token, label);
    if (matched === token.length) {
      score += 5 * token.length;
    } else if (category.includes(token)) {
      score += 10;
    } else if (shortcut.includes(token)) {
      score += 10;
    } else if (keywords.includes(token)) {
      score += 8;
    } else {
      return 0;
    }
  }

  return score + commandFrecencyPoints(frecencyScore);
}
