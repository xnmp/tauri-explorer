/**
 * API client for file operations.
 * Issue: tauri-explorer-nv2y - Migrated from Python FastAPI to Rust Tauri commands
 *
 * Owns filesystem and directory operations. Other API concerns live in their
 * dedicated sibling modules and are imported directly by feature consumers.
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { E2E_HOOKS_ENABLED } from "$lib/domain/e2e-hooks";
import {
  invoke,
  extractError,
  virtualPathGuard,
  dataUriToBlobUrl,
  type ApiResult,
} from "./common";
import { providerFor } from "$lib/plugins/fs-providers";
import { logFrontendDiagnostic } from "./frontend-log";

interface DirectoryListingE2EProbe {
  targetPath: string;
  delays: number[];
  calls: number;
  completed: number;
  starts: number[];
}

let directoryListingE2EProbe: DirectoryListingE2EProbe | null = null;

function publishReadyDirectoryWatch(path: string): void {
  if (!E2E_HOOKS_ENABLED || typeof document === "undefined") return;
  const encoded = document.documentElement.dataset.e2eReadyDirectoryWatches;
  const readyPaths: string[] = encoded ? JSON.parse(encoded) : [];
  if (!readyPaths.includes(path)) readyPaths.push(path);
  document.documentElement.dataset.e2eReadyDirectoryWatches = JSON.stringify(readyPaths);
}

function publishDirectoryListingE2EProbe(): void {
  if (!E2E_HOOKS_ENABLED || typeof document === "undefined") return;
  if (directoryListingE2EProbe) {
    document.documentElement.dataset.e2eDirectoryListingProbe = JSON.stringify({
      calls: directoryListingE2EProbe.calls,
      completed: directoryListingE2EProbe.completed,
      starts: directoryListingE2EProbe.starts,
    });
  } else {
    delete document.documentElement.dataset.e2eDirectoryListingProbe;
  }
}

// WebKitWebDriver evaluates injected scripts in an isolated JavaScript world,
// so replacing window.__TAURI_INTERNALS__.invoke there cannot instrument the
// application's Tauri calls. This dev-only DOM event crosses that boundary and
// configures deterministic timing around the real backend listing invocation.
if (E2E_HOOKS_ENABLED && typeof window !== "undefined") {
  window.addEventListener("e2e-directory-listing-probe", ((
    event: CustomEvent<{ targetPath?: string; delays?: number[] }>,
  ) => {
    const targetPath = event.detail?.targetPath;
    directoryListingE2EProbe = targetPath
      ? {
          targetPath,
          delays: event.detail.delays ?? [],
          calls: 0,
          completed: 0,
          starts: [],
        }
      : null;
    publishDirectoryListingE2EProbe();
  }) as EventListener);
}

/**
 * Fetch directory listing from Tauri backend.
 *
 * @param path - Absolute path to directory
 * @returns Result with DirectoryListing or error message
 */
export async function fetchDirectory(
  path: string
): Promise<ApiResult<DirectoryListing>> {
  // Virtual (`scheme://…`) paths are served by a plugin provider, not the
  // real-fs backend.
  const provider = providerFor(path);
  if (provider) {
    try {
      return { ok: true, data: await provider.list(path) };
    } catch (err) {
      return { ok: false, error: extractError(err) };
    }
  }
  try {
    const data = await invoke<DirectoryListing>("list_directory", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Returns true when `path` has no entries visible under the given hidden-file rule.
 * Used by miller view's "hide empty folders" feature. Errors yield false so
 * unreadable folders aren't optimistically hidden.
 */
export async function isDirectoryEmpty(
  path: string,
  includeHidden: boolean
): Promise<boolean> {
  try {
    return await invoke<boolean>("is_directory_empty", { path, includeHidden });
  } catch {
    return false;
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
  const guard = virtualPathGuard(parentPath);
  if (guard) return guard;
  try {
    const data = await invoke<FileEntry>("create_directory", {
      parentPath,
      name,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Create a new empty file (touch) inside a parent directory.
 * @param parentPath - Path to parent directory
 * @param name - Name of new file
 * @returns Result with created FileEntry or error message
 */
export async function createEmptyFile(
  parentPath: string,
  name: string
): Promise<ApiResult<FileEntry>> {
  const guard = virtualPathGuard(parentPath);
  if (guard) return guard;
  try {
    const data = await invoke<FileEntry>("create_empty_file", {
      parentPath,
      name,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    const data = await invoke<FileEntry>("rename_entry", { path, newName });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("move_to_trash", { path });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Move multiple files/directories to the system trash.
 *
 * @param paths - Array of full paths to delete
 * @returns Result indicating success or error message
 */
export async function deleteMultipleEntries(paths: string[]): Promise<ApiResult<void>> {
  try {
    await invoke("move_multiple_to_trash", { paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Permanently delete a file or directory (bypasses trash). */
export async function deleteEntryPermanent(path: string): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("delete_entry_permanent", { path });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Restore files from the system trash by their original paths.
 *
 * @param paths - Array of original paths to restore
 * @returns Result indicating success or error message
 */
export async function restoreFromTrash(paths: string[]): Promise<ApiResult<void>> {
  try {
    await invoke("restore_from_trash", { paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
  destDir: string,
  overwrite = false,
  jobId?: number,
): Promise<ApiResult<FileEntry>> {
  const guard = virtualPathGuard(source, destDir);
  if (guard) return guard;
  try {
    const data = await invoke<FileEntry>("copy_entry", { source, destDir, overwrite, jobId });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Cancel a running copy job. The pending copyEntry call fails with
 *  "Copy cancelled" and any partial copy is removed. Best-effort — the job
 *  may already have finished. */
export async function cancelCopy(jobId: number): Promise<void> {
  try {
    await invoke("cancel_copy", { jobId });
  } catch {
    // Cancellation is best-effort; the job may already have finished.
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
  destDir: string,
  overwrite = false
): Promise<ApiResult<FileEntry>> {
  const guard = virtualPathGuard(source, destDir);
  if (guard) return guard;
  try {
    const data = await invoke<FileEntry>("move_entry", { source, destDir, overwrite });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Resolved target of a Windows `.lnk` shortcut. */
export interface ShortcutTarget {
  target: string;
  isDir: boolean;
}

/**
 * Resolve a Windows `.lnk` shortcut to the file/folder it points at.
 * Returns null when `path` isn't a (resolvable, existing) shortcut — callers
 * should then act on the original path.
 */
export async function resolveShortcut(path: string): Promise<ShortcutTarget | null> {
  try {
    return (await invoke<ShortcutTarget | null>("resolve_shortcut", { path })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Write text content to a new file.
 */
export async function writeTextFile(path: string, content: string): Promise<ApiResult<FileEntry>> {
  try {
    const data = await invoke<FileEntry>("write_text_file", { path, content });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Read a text file's contents.
 *
 * @param path - Full path to file
 * @param maxBytes - Maximum file size in bytes (default 1MB)
 * @returns Result with file content or error message
 */
export async function readTextFile(path: string, maxBytes?: number): Promise<ApiResult<string>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  const startedAt = Date.now();
  try {
    const content = await invoke<string>("read_text_file", { path, maxBytes: maxBytes ?? null });
    console.debug("[preview] read_text_file completed", {
      path,
      maxBytes: maxBytes ?? null,
      bytes: content.length,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: true, data: content };
  } catch (err) {
    const error = extractError(err);
    console.warn("[preview] read_text_file failed", {
      path,
      maxBytes: maxBytes ?? null,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    logFrontendDiagnostic("preview read_text_file failed", {
      path,
      maxBytes: maxBytes ?? null,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, error };
  }
}

/**
 * Read an image file's bytes through the backend and return them as a blob URL.
 *
 * Fallback for previewing images the `asset:` protocol can't serve — chiefly
 * cloud-mounted files (Google Drive, OneDrive) whose placeholder paths the
 * asset server fails to stream. Reading via `fs` forces the cloud client to
 * hydrate the file first.
 *
 * @param path - Full path to the image file
 * @param maxBytes - Optional size cap (backend default 32 MB)
 * @returns Result with an object-URL (blob:) or error
 */
export async function readImageAsBlobUrl(
  path: string,
  maxBytes?: number
): Promise<ApiResult<string>> {
  const startedAt = Date.now();
  try {
    const dataUri = await invoke<string>("read_image_data_url", {
      path,
      maxBytes: maxBytes ?? null,
    });
    console.debug("[preview] read_image_data_url completed", {
      path,
      maxBytes: maxBytes ?? null,
      dataUriBytes: dataUri.length,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: true, data: dataUriToBlobUrl(dataUri) };
  } catch (err) {
    const error = extractError(err);
    console.warn("[preview] read_image_data_url failed", {
      path,
      maxBytes: maxBytes ?? null,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    logFrontendDiagnostic("preview read_image_data_url failed", {
      path,
      maxBytes: maxBytes ?? null,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, error };
  }
}

/**
 * Size estimation for file operations progress.
 */
export interface SizeEstimate {
  fileCount: number;
  totalBytes: number;
}

/**
 * Estimate total file count and size for a list of paths.
 * Recursively walks directories. Used for progress estimation.
 *
 * @param paths - List of file/directory paths
 * @returns Result with size estimate or error
 */
export async function estimateSize(paths: string[]): Promise<ApiResult<SizeEstimate>> {
  try {
    const data = await invoke<SizeEstimate>("estimate_size", { paths });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Batch-check which paths exist on the filesystem. */
export async function checkPathsExist(paths: string[]): Promise<boolean[]> {
  try {
    return await invoke<boolean[]>("check_paths_exist", { paths });
  } catch {
    return paths.map(() => true); // assume exists on error
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
  const startedAt = Date.now();
  console.debug("[navigation] start_streaming_directory requested", { path });
  // Virtual paths never stream: the provider returns the full listing inline
  // (listing_id null), which the caller treats as a non-streaming result.
  const provider = providerFor(path);
  if (provider) {
    try {
      const data = await provider.list(path);
      console.debug("[navigation] virtual directory listing completed", {
        path,
        entries: data.entries.length,
        elapsedMs: Date.now() - startedAt,
      });
      return { ok: true, data: { ...data, listing_id: null } };
    } catch (err) {
      const error = extractError(err);
      console.warn("[navigation] virtual directory listing failed", {
        path,
        error,
        elapsedMs: Date.now() - startedAt,
      });
      logFrontendDiagnostic("navigation virtual directory listing failed", {
        path,
        error,
        elapsedMs: Date.now() - startedAt,
      });
      return { ok: false, error };
    }
  }

  const e2eProbe =
    E2E_HOOKS_ENABLED && directoryListingE2EProbe?.targetPath === path
      ? directoryListingE2EProbe
      : null;
  const e2eCallIndex = e2eProbe?.calls ?? -1;
  if (e2eProbe) {
    e2eProbe.calls += 1;
    e2eProbe.starts.push(Date.now());
    publishDirectoryListingE2EProbe();
  }

  try {
    const data = await invoke<DirectoryListing>("start_streaming_directory", { path });
    if (e2eProbe) {
      const delay = e2eProbe.delays[e2eCallIndex] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      e2eProbe.completed += 1;
      publishDirectoryListingE2EProbe();
    }
    console.debug("[navigation] start_streaming_directory completed", {
      path,
      listingId: data.listing_id,
      entries: data.entries.length,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: true, data };
  } catch (err) {
    const error = extractError(err);
    console.warn("[navigation] start_streaming_directory failed", {
      path,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    logFrontendDiagnostic("navigation start_streaming_directory failed", {
      path,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, error };
  }
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
    return { ok: false, error: extractError(err) };
  }
}

// ===================
// Filesystem Watcher
// Issue: tauri-explorer-2gdf
// ===================

/**
 * Start watching a directory for external changes.
 * Refcounted — safe to call multiple times for the same path.
 */
export async function watchDirectory(path: string): Promise<void> {
  await invoke("watch_directory", { path });
  publishReadyDirectoryWatch(path);
}

/**
 * Stop watching a directory. Decrements refcount; OS watch removed at zero.
 */
export async function unwatchDirectory(path: string): Promise<void> {
  await invoke("unwatch_directory", { path });
}

// ===================
// Symlink Operations
// Issue: tauri-vozb
// ===================

/**
 * Create a symbolic link.
 *
 * @param targetPath - Path that the symlink points to
 * @param linkPath - Path where the symlink will be created
 * @returns Result with the created symlink entry or error
 */
export async function createSymlink(
  targetPath: string,
  linkPath: string
): Promise<ApiResult<FileEntry>> {
  const guard = virtualPathGuard(targetPath, linkPath);
  if (guard) return guard;
  try {
    const data = await invoke<FileEntry>("create_symlink", { targetPath, linkPath });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
