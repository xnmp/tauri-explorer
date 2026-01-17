/**
 * API client for file operations.
 * Issue: tauri-explorer-nv2y - Migrated from Python FastAPI to Rust Tauri commands
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri, mockInvoke } from "./mock-invoke";

// Use real Tauri invoke in Tauri, mock invoke in browser for E2E testing
const invoke = isTauri() ? tauriInvoke : mockInvoke;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Fetch directory listing from Tauri backend.
 *
 * @param path - Absolute path to directory
 * @returns Result with DirectoryListing or error message
 */
export async function fetchDirectory(
  path: string
): Promise<ApiResult<DirectoryListing>> {
  try {
    const data = await invoke<DirectoryListing>("list_directory", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Create a new directory.
 *
 * @param parentPath - Path to parent directory
 * @param name - Name of new directory
 * @returns Result with created FileEntry or error message
 */
export async function createDirectory(
  parentPath: string,
  name: string
): Promise<ApiResult<FileEntry>> {
  try {
    const data = await invoke<FileEntry>("create_directory", {
      parentPath,
      name,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Rename a file or directory.
 *
 * @param path - Full path to file/directory
 * @param newName - New name (just the name, not full path)
 * @returns Result with renamed FileEntry or error message
 */
export async function renameEntry(
  path: string,
  newName: string
): Promise<ApiResult<FileEntry>> {
  try {
    const data = await invoke<FileEntry>("rename_entry", { path, newName });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Delete a file or directory by moving it to the system trash/recycle bin.
 *
 * Uses Tauri command for cross-platform trash support:
 * - Windows: Recycle Bin
 * - macOS: Trash
 * - Linux: Freedesktop Trash
 *
 * @param path - Full path to file/directory to delete
 * @returns Result indicating success or error message
 */
export async function deleteEntry(path: string): Promise<ApiResult<void>> {
  try {
    await invoke("move_to_trash", { path });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Copy a file or directory to a destination.
 *
 * @param source - Full path to source file/directory
 * @param destDir - Destination directory path
 * @returns Result with copied FileEntry or error message
 */
export async function copyEntry(
  source: string,
  destDir: string
): Promise<ApiResult<FileEntry>> {
  try {
    const data = await invoke<FileEntry>("copy_entry", { source, destDir });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Move a file or directory to a destination.
 *
 * @param source - Full path to source file/directory
 * @param destDir - Destination directory path
 * @returns Result with moved FileEntry or error message
 */
export async function moveEntry(
  source: string,
  destDir: string
): Promise<ApiResult<FileEntry>> {
  try {
    const data = await invoke<FileEntry>("move_entry", { source, destDir });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Open a file in the system's default application.
 *
 * @param path - Full path to file to open
 * @returns Result indicating success or error message
 */
export async function openFile(path: string): Promise<ApiResult<void>> {
  try {
    await invoke("open_file", { path });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Get the user's home directory path.
 *
 * @returns Result with home directory path or error message
 */
export async function getHomeDirectory(): Promise<ApiResult<string>> {
  try {
    const path = await invoke<string>("get_home_directory");
    return { ok: true, data: path };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

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
    return { ok: false, error: String(err) };
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
  limit: number = 20
): Promise<ApiResult<number>> {
  try {
    const searchId = await invoke<number>("start_streaming_search", {
      query,
      root,
      limit,
    });
    return { ok: true, data: searchId };
  } catch (err) {
    return { ok: false, error: String(err) };
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
    return { ok: false, error: String(err) };
  }
}

/**
 * Event payload for streaming directory entries.
 */
export interface DirectoryEntriesEvent {
  listingId: number;
  path: string;
  entries: FileEntry[];
  done: boolean;
  totalCount: number;
}

/**
 * Start streaming directory listing.
 * Returns first batch immediately, remaining entries emitted via 'directory-entries' events.
 * For small directories (<100 files), returns everything in one response.
 *
 * @param path - Absolute path to directory
 * @returns Result with initial DirectoryListing (path may include listing ID for event correlation)
 */
export async function startStreamingDirectory(
  path: string
): Promise<ApiResult<DirectoryListing>> {
  try {
    const data = await invoke<DirectoryListing>("start_streaming_directory", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Extract listing ID from streaming directory response path.
 * Returns null if path doesn't contain a listing ID (small directory).
 */
export function extractListingId(pathWithId: string): { path: string; listingId: number | null } {
  const match = pathWithId.match(/^(.+)\|listing:(\d+)$/);
  if (match) {
    return { path: match[1], listingId: parseInt(match[2], 10) };
  }
  return { path: pathWithId, listingId: null };
}

/**
 * Cancel an active directory listing.
 *
 * @param listingId - ID of the listing to cancel
 * @returns Result indicating success or error message
 */
export async function cancelDirectoryListing(listingId: number): Promise<ApiResult<void>> {
  try {
    await invoke("cancel_directory_listing", { listingId });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ===================
// Thumbnail Generation
// Issue: tauri-explorer-im3m
// ===================

/**
 * Get the path to a cached thumbnail for an image file.
 * Generates the thumbnail if not already cached.
 *
 * @param path - Full path to image file
 * @param size - Optional thumbnail size (default 128)
 * @returns Result with cached thumbnail path or error
 */
export async function getThumbnail(
  path: string,
  size?: number
): Promise<ApiResult<string>> {
  try {
    const thumbnailPath = await invoke<string>("get_thumbnail", { path, size });
    return { ok: true, data: thumbnailPath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Get thumbnail as base64 data URI.
 * More efficient for display as it avoids additional file reads.
 *
 * @param path - Full path to image file
 * @param size - Optional thumbnail size (default 128)
 * @returns Result with data URI (data:image/jpeg;base64,...) or error
 */
export async function getThumbnailData(
  path: string,
  size?: number
): Promise<ApiResult<string>> {
  try {
    const dataUri = await invoke<string>("get_thumbnail_data", { path, size });
    return { ok: true, data: dataUri };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Thumbnail cache statistics.
 */
export interface ThumbnailCacheStats {
  count: number;
  totalSize: number;
  path: string;
}

/**
 * Clear the thumbnail cache.
 *
 * @returns Result with bytes cleared or error
 */
export async function clearThumbnailCache(): Promise<ApiResult<number>> {
  try {
    const bytesCleared = await invoke<number>("clear_thumbnail_cache");
    return { ok: true, data: bytesCleared };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Get thumbnail cache statistics.
 *
 * @returns Result with cache stats or error
 */
export async function getThumbnailCacheStats(): Promise<ApiResult<ThumbnailCacheStats>> {
  try {
    const stats = await invoke<ThumbnailCacheStats>("get_thumbnail_cache_stats");
    return { ok: true, data: stats };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
