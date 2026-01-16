/**
 * API client for file operations.
 * Issue: tauri-explorer-nv2y - Migrated from Python FastAPI to Rust Tauri commands
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { invoke } from "@tauri-apps/api/core";

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
