/**
 * API client for file operations.
 * Issue: tauri-explorer-4v1
 */

import type { DirectoryListing } from "$lib/domain/file";

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
