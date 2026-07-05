/**
 * API client for fuzzy file search and ripgrep-based content search.
 * Issue: refactor/audit-tier4-splits (#212)
 */

import { invoke, extractError, type ApiResult } from "./common";

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

interface SearchResponse {
  results: SearchResult[];
}

/**
 * Fuzzy search for files recursively in a directory.
 *
 * @param query - Search query
 * @param root - Root directory to search in
 * @param limit - Maximum number of results
 * @returns Result with matching files or error message
 */
export async function fuzzySearch(
  query: string,
  root: string,
  limit: number = 20
): Promise<ApiResult<SearchResult[]>> {
  try {
    const response = await invoke<SearchResponse>("fuzzy_search", {
      query,
      root,
      limit,
    });
    return { ok: true, data: response.results };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Event payload for streaming search results.
 */
export interface SearchResultsEvent {
  searchId: number;
  results: SearchResult[];
  done: boolean;
  totalScanned: number;
}

/**
 * Start a streaming fuzzy search that emits results incrementally.
 * Listen for 'search-results' events to receive results.
 *
 * @param query - Search query
 * @param root - Root directory to search in
 * @param limit - Maximum number of results
 * @returns Result with search ID or error message
 */
export async function startStreamingSearch(
  query: string,
  root: string,
  limit: number = 20,
  boostPrefix?: string,
): Promise<ApiResult<number>> {
  try {
    const searchId = await invoke<number>("start_streaming_search", {
      query,
      root,
      limit,
      boostPrefix: boostPrefix ?? null,
    });
    return { ok: true, data: searchId };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Cancel an active streaming search.
 *
 * @param searchId - ID of the search to cancel
 * @returns Result indicating success or error message
 */
export async function cancelSearch(searchId: number): Promise<ApiResult<void>> {
  try {
    await invoke("cancel_search", { searchId });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ===================
// Content Search (ripgrep)
// Issue: tauri-explorer-3a1q
// ===================

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

/**
 * Event payload for streaming content search results.
 */
export interface ContentSearchEvent {
  searchId: number;
  results: ContentSearchResult[];
  done: boolean;
  filesSearched: number;
  totalMatches: number;
}

/**
 * Result of starting a content search. With the real backend, results stream
 * via 'content-search-results' events and `searchId` identifies the stream.
 * Outside Tauri (browser/mock mode) the event system is unavailable, so the
 * mock returns the complete result set inline (`searchId` null) — same
 * fallback shape as the streaming directory listing.
 */
export interface ContentSearchStart {
  searchId: number | null;
  inline: ContentSearchEvent | null;
}

/**
 * Start a streaming content search using ripgrep.
 * Listen for 'content-search-results' events to receive results.
 *
 * @param query - Search query (text or regex pattern)
 * @param root - Root directory to search in
 * @param caseSensitive - Whether search is case-sensitive
 * @param regexMode - Whether to treat query as regex pattern
 * @param maxResults - Maximum number of results
 * @returns Result with stream id or inline results, or an error message
 */
export async function startContentSearch(
  query: string,
  root: string,
  caseSensitive: boolean = false,
  regexMode: boolean = false,
  maxResults: number = 500
): Promise<ApiResult<ContentSearchStart>> {
  try {
    const raw = await invoke<number | ContentSearchEvent>("start_content_search", {
      query,
      root,
      caseSensitive,
      regexMode,
      maxResults,
    });
    return typeof raw === "number"
      ? { ok: true, data: { searchId: raw, inline: null } }
      : { ok: true, data: { searchId: null, inline: raw } };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Cancel an active content search.
 *
 * @param searchId - ID of the search to cancel
 * @returns Result indicating success or error message
 */
export async function cancelContentSearch(searchId: number): Promise<ApiResult<void>> {
  try {
    await invoke("cancel_content_search", { searchId });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
