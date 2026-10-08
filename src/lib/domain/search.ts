/**
 * Search result from fuzzy file search.
 */
export interface SearchResult {
  name: string;
  path: string;
  relativePath: string;
  score: number;
  kind: "file" | "directory";
}

