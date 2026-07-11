/**
 * Content search (ripgrep) result types.
 * Issue: tauri-explorer-3a1q
 *
 * Domain-owned so pure result-shaping logic (e.g. content-search-flatten.ts)
 * doesn't depend on the api/ layer. `api/search.ts` imports and re-exports
 * these so existing `$lib/api/*` import sites keep working.
 */

/**
 * A single match within a file.
 */
export interface ContentMatch {
  lineNumber: number;
  column: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

/**
 * Search result for a single file containing matches.
 */
export interface ContentSearchResult {
  path: string;
  relativePath: string;
  matches: ContentMatch[];
}
