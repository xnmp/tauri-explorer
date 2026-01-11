/**
 * API client for file operations.
 * Issue: tauri-explorer-4v1, tauri-explorer-jql, tauri-explorer-h3n, tauri-explorer-x25
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";

const API_BASE = "http://127.0.0.1:8008/api";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Fetch directory listing from the API.
 *
 * @param path - Absolute path to directory
 * @returns Result with DirectoryListing or error message
 */
export async function fetchDirectory(
  path: string
): Promise<ApiResult<DirectoryListing>> {
  try {
    const url = `${API_BASE}/files/list?path=${encodeURIComponent(path)}`;
    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body.detail ?? `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }

    const data: DirectoryListing = await response.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Create a new directory.
 * Issue: tauri-explorer-jql
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
    const response = await fetch(`${API_BASE}/files/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parentPath, name }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body.detail ?? `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }

    const data: FileEntry = await response.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Rename a file or directory.
 * Issue: tauri-explorer-bae
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
    const response = await fetch(`${API_BASE}/files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, new_name: newName }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body.detail ?? `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }

    const data: FileEntry = await response.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Delete a file or directory.
 * Issue: tauri-explorer-h3n
 *
 * @param path - Full path to file/directory to delete
 * @returns Result indicating success or error message
 */
export async function deleteEntry(path: string): Promise<ApiResult<void>> {
  try {
    const url = `${API_BASE}/files/delete?path=${encodeURIComponent(path)}`;
    const response = await fetch(url, { method: "DELETE" });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body.detail ?? `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }

    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Copy a file or directory to a destination.
 * Issue: tauri-explorer-x25
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
    const response = await fetch(`${API_BASE}/files/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, dest_dir: destDir }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body.detail ?? `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }

    const data: FileEntry = await response.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Move a file or directory to a destination.
 * Issue: tauri-explorer-x25
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
    const response = await fetch(`${API_BASE}/files/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, dest_dir: destDir }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body.detail ?? `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }

    const data: FileEntry = await response.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}