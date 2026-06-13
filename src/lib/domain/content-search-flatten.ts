/**
 * Content search result flattening and pagination.
 * Pure data processing — no Svelte reactivity or DOM concerns.
 * Extracted from ContentSearchDialog.svelte.
 */

import type { ContentSearchResult, ContentMatch } from "$lib/api/files";

export interface FlattenedResult {
  filePath: string;
  relativePath: string;
  match: ContentMatch;
  isFirstInFile: boolean;
  isShowMore?: boolean;
  hiddenCount?: number;
  totalFileMatches?: number;
}

const COLLAPSED_LIMIT = 5;

/** Flatten a single file's matches, respecting collapsed/expanded state. */
export function flattenFile(
  file: ContentSearchResult,
  filterLower: string,
  expandedFiles: ReadonlySet<string>,
): FlattenedResult[] {
  const isExpanded = expandedFiles.has(file.path);
  const filtered: ContentMatch[] = [];
  for (const match of file.matches) {
    if (filterLower && !match.lineContent.toLowerCase().includes(filterLower) &&
        !file.relativePath.toLowerCase().includes(filterLower)) {
      continue;
    }
    filtered.push(match);
  }
  if (filtered.length === 0) return [];

  const limit = isExpanded ? filtered.length : Math.min(COLLAPSED_LIMIT, filtered.length);
  const items: FlattenedResult[] = [];
  for (let i = 0; i < limit; i++) {
    items.push({
      filePath: file.path,
      relativePath: file.relativePath,
      match: filtered[i],
      isFirstInFile: i === 0,
      totalFileMatches: filtered.length,
    });
  }

  if (!isExpanded && filtered.length > COLLAPSED_LIMIT) {
    items.push({
      filePath: file.path,
      relativePath: file.relativePath,
      match: filtered[0],
      isFirstInFile: false,
      isShowMore: true,
      hiddenCount: filtered.length - COLLAPSED_LIMIT,
      totalFileMatches: filtered.length,
    });
  }
  return items;
}

/** Flatten a batch of new results (incremental, O(batch)). */
export function flattenBatch(
  newResults: ContentSearchResult[],
  filterLower: string,
  expandedFiles: ReadonlySet<string>,
): FlattenedResult[] {
  const batch: FlattenedResult[] = [];
  for (const file of newResults) {
    batch.push(...flattenFile(file, filterLower, expandedFiles));
  }
  return batch;
}

/** Full rebuild of flattened results from all search results. */
export function rebuildAllFlattened(
  results: ContentSearchResult[],
  filterLower: string,
  expandedFiles: ReadonlySet<string>,
): FlattenedResult[] {
  const rebuilt: FlattenedResult[] = [];
  for (const file of results) {
    rebuilt.push(...flattenFile(file, filterLower, expandedFiles));
  }
  return rebuilt;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function highlightMatch(lineContent: string, matchStart: number, matchEnd: number): string {
  const before = escapeHtml(lineContent.slice(0, matchStart));
  const match = escapeHtml(lineContent.slice(matchStart, matchEnd));
  const after = escapeHtml(lineContent.slice(matchEnd));
  return `${before}<mark>${match}</mark>${after}`;
}
