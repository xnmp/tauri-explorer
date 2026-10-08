/**
 * API client for file operations.
 * Issue: tauri-explorer-nv2y - Migrated from Python FastAPI to Rust Tauri commands
 *
 * Owns filesystem and directory operations. Other API concerns live in their
 * dedicated sibling modules and are imported directly by feature consumers.
 */

import { decodeDirectoryListing, type CompactDirectoryListing } from "./directory-wire";
import { fileBatchError, type FileBatchOutcome } from "$lib/domain/file-batch-outcome";
import type { DirectoryListing, FileEntry, FileMutationReceipt } from "$lib/domain/file";
import { E2E_HOOKS_ENABLED } from "$lib/api/e2e-hooks";
import {
  invoke,
  isTauri,
  extractError,
  virtualPathGuard,
  dataUriToBlobUrl,
  type ApiResult,
} from "./common";
import { providerFor } from "$lib/plugins/fs-providers";
import { logFrontendDiagnostic } from "./frontend-log";
import { getNativeResourceSession } from "./native-resource-session";
import { invokeFileMutation } from "./file-mutations";
import type { FrontendLoadPhase } from "$lib/domain/load-diagnostics";

/** Slow-load trace seam (#1022): phases are recorded and the ID is handed to
 *  the native command so its own phases join the same trace. */
export interface ListingTrace {
  readonly id: string;
  phase(phase: FrontendLoadPhase): void;
}

/** Commands whose successful result a native E2E probe may hold before publication. */
export type HeldFileMutationCommand = "create_directory" | "rename_entry";

/**
 * Observation seam around one native directory listing. `begin` runs before
 * the backend request; its continuation runs after the reply decodes and
 * before the listing is returned. Only `src/test-support/` installs one, and
 * only hook builds consult it (see `api/e2e-hooks.ts`).
 */
export interface DirectoryListingInterceptor {
  begin(path: string): (() => Promise<void>) | null;
}

/** Observation seam after a successful create/rename, before its publication. */
export type FileMutationInterceptor = (
  command: HeldFileMutationCommand,
  targetPath: string,
  resultPath: string,
) => Promise<void>;

let listingInterceptor: DirectoryListingInterceptor | null = null;
let mutationInterceptor: FileMutationInterceptor | null = null;

/** Install a listing interceptor; the returned function removes it. */
export function interceptDirectoryListings(interceptor: DirectoryListingInterceptor): () => void {
  listingInterceptor = interceptor;
  return () => { if (listingInterceptor === interceptor) listingInterceptor = null; };
}

/** Install a mutation interceptor; the returned function removes it. */
export function interceptFileMutations(interceptor: FileMutationInterceptor): () => void {
  mutationInterceptor = interceptor;
  return () => { if (mutationInterceptor === interceptor) mutationInterceptor = null; };
}

async function afterFileMutation(
  command: HeldFileMutationCommand,
  targetPath: string,
  result: ApiResult<FileMutationReceipt>,
): Promise<void> {
  if (E2E_HOOKS_ENABLED && result.ok && mutationInterceptor) {
    await mutationInterceptor(command, targetPath, result.data.path);
  }
}

function publishReadyDirectoryWatch(path: string): void {
  if (!E2E_HOOKS_ENABLED || typeof document === "undefined") return;
  const encoded = document.documentElement.dataset.e2eReadyDirectoryWatches;
  const readyPaths: string[] = encoded ? JSON.parse(encoded) : [];
  if (!readyPaths.includes(path)) readyPaths.push(path);
  document.documentElement.dataset.e2eReadyDirectoryWatches = JSON.stringify(readyPaths);
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
    const data = await invoke<CompactDirectoryListing>("list_directory", { path });
    return { ok: true, data: decodeDirectoryListing(data) };
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
 * @returns Result with the committed path and optional entry metadata
 */
export async function createDirectory(
  parentPath: string,
  name: string
): Promise<ApiResult<FileMutationReceipt>> {
  const guard = virtualPathGuard(parentPath);
  if (guard) return guard;
  try {
    const result = await invokeFileMutation<FileMutationReceipt>("create_directory", {
      parentPath,
      name,
    });
    await afterFileMutation("create_directory", parentPath, result);
    return result;
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Create a new empty file (touch) inside a parent directory.
 * @param parentPath - Path to parent directory
 * @param name - Name of new file
 * @returns Result with the committed path and optional entry metadata
 */
export async function createEmptyFile(
  parentPath: string,
  name: string
): Promise<ApiResult<FileMutationReceipt>> {
  const guard = virtualPathGuard(parentPath);
  if (guard) return guard;
  try {
    return await invokeFileMutation<FileMutationReceipt>("create_empty_file", {
      parentPath,
      name,
    });
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Rename a file or directory.
 *
 * @param path - Full path to file/directory
 * @param newName - New name (just the name, not full path)
 * @returns Result with the committed path and optional entry metadata
 */
export async function renameEntry(
  path: string,
  newName: string
): Promise<ApiResult<FileMutationReceipt>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    const result = await invokeFileMutation<FileMutationReceipt>("rename_entry", { path, newName });
    await afterFileMutation("rename_entry", path, result);
    return result;
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Native-owned deletion of the complete selection, with per-path outcomes. */
export async function deleteEntries(paths: string[], permanent = false): Promise<ApiResult<FileBatchOutcome>> {
  for (const path of paths) {
    const guard = virtualPathGuard(path);
    if (guard) return guard;
  }
  return invokeFileMutation<FileBatchOutcome>("delete_entries", { paths, permanent });
}

async function deleteOne(path: string, permanent: boolean): Promise<ApiResult<void>> {
  const result = await deleteEntries([path], permanent);
  if (!result.ok) return result;
  const error = fileBatchError(result.data);
  return error ? { ok: false, error } : { ok: true, data: undefined, ...(result.warning ? { warning: result.warning } : {}) };
}

export const deleteEntry = (path: string): Promise<ApiResult<void>> => deleteOne(path, false);
export const deleteEntryPermanent = (path: string): Promise<ApiResult<void>> => deleteOne(path, true);
export const deleteMultipleEntries = (paths: string[]): Promise<ApiResult<FileBatchOutcome>> => deleteEntries(paths);


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
export async function writeTextFile(path: string, content: string): Promise<ApiResult<FileMutationReceipt>> {
  try {
    return await invokeFileMutation<FileMutationReceipt>("write_text_file", { path, content });
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

/** Selection validation fails closed; optional history pruning keeps its existing fallback. */
export async function verifyPathsExist(paths: readonly string[], kind: "file" | "directory"): Promise<ApiResult<boolean>> {
  try {
    const exists = await invoke<unknown>("check_paths_exist", { paths, directory: kind === "directory" });
    if (!Array.isArray(exists) || exists.length !== paths.length || exists.some(value => typeof value !== "boolean")) {
      return { ok: false, error: "Invalid filesystem validation response" };
    }
    return { ok: true, data: exists.every(Boolean) };
  } catch (error) { return { ok: false, error: extractError(error) }; }
}

/** Batch-check which paths exist on the filesystem. */
export async function checkPathsExist(paths: string[]): Promise<boolean[]> {
  try {
    return await invoke<boolean[]>("check_paths_exist", { paths });
  } catch {
    return paths.map(() => true); // assume exists on error
  }
}

/** A complete fresh listing, optionally coupled to a native observation lease. */
export interface ObservedDirectoryListing extends DirectoryListing {
  watch_lease?: DirectoryWatchLease;
}

/**
 * A native `start_observed_directory` reply must carry a well-formed lease:
 * an omitted or malformed one would otherwise decode successfully and be
 * accepted as the new watch by `directory-listing.ts`, silently releasing the
 * previous (working) watch and leaving refresh permanently stopped for that
 * pane, since the garbage lease never matches a later watcher event.
 */
function isValidWatchLease(lease: unknown): lease is DirectoryWatchLease {
  return (
    !!lease && typeof lease === "object" &&
    typeof (lease as DirectoryWatchLease).id === "string" &&
    typeof (lease as DirectoryWatchLease).path === "string"
  );
}

export async function loadDirectory(
  path: string,
  observation?: { discard(lease: DirectoryWatchLease): void },
  trace?: ListingTrace,
): Promise<ApiResult<ObservedDirectoryListing>> {
  const startedAt = Date.now();
  console.debug("[navigation] list_directory_fresh requested", { path });
  // Providers and native directories share the same complete-snapshot contract.
  const provider = providerFor(path);
  if (provider) {
    try {
      trace?.phase("provider");
      const data = await provider.list(path);
      console.debug("[navigation] virtual directory listing completed", {
        path,
        entries: data.entries.length,
        elapsedMs: Date.now() - startedAt,
      });
      return { ok: true, data };
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

  const settleListing = E2E_HOOKS_ENABLED ? listingInterceptor?.begin(path) ?? null : null;

  let acquired: (CompactDirectoryListing & { watch_lease?: DirectoryWatchLease }) | undefined;
  try {
    const native = isTauri();
    const observed = Boolean(observation && native);
    trace?.phase("native");
    const sessionId = observed ? await getNativeResourceSession() : undefined;
    const traced = trace ? { traceId: trace.id } : {};
    const payload = observed
      ? await invoke<CompactDirectoryListing & { watch_lease?: DirectoryWatchLease }>("start_observed_directory", {
          path, sessionId, ...traced,
        })
      : await invoke<CompactDirectoryListing & { watch_lease?: DirectoryWatchLease }>("list_directory_fresh", { path, ...traced });
    acquired = payload;
    if (observed && !isValidWatchLease(payload.watch_lease)) {
      throw new Error("Invalid native directory watch lease");
    }
    trace?.phase("decode");
    const data: ObservedDirectoryListing = { ...decodeDirectoryListing(payload), watch_lease: payload.watch_lease };
    if (data.watch_lease) publishReadyDirectoryWatch(data.watch_lease.path);
    if (settleListing) {
      trace?.phase("test-hold");
      await settleListing();
    }
    console.debug("[navigation] list_directory_fresh completed", {
      path,
      entries: data.entries.length,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: true, data };
  } catch (err) {
    // Decoding and the optional native probe can fail after acquisition. Keep the same
    // owner responsible for releasing late leases, including release retries. A
    // malformed lease (the failure this catch is also reached for) has nothing
    // safely releasable — only a well-formed lease is discarded.
    if (acquired?.watch_lease && isValidWatchLease(acquired.watch_lease)) {
      observation?.discard(acquired.watch_lease);
    }
    const error = extractError(err);
    console.warn("[navigation] list_directory_fresh failed", {
      path,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    logFrontendDiagnostic("navigation list_directory_fresh failed", {
      path,
      error,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, error };
  }
}

// ===================
// Filesystem Watcher
// Issue: tauri-explorer-2gdf
// ===================

/**
 * Start watching a directory for external changes and return its release lease.
 */
export interface DirectoryWatchLease { id: string; path: string }

export async function watchDirectory(path: string): Promise<DirectoryWatchLease> {
  const sessionId = await getNativeResourceSession();
  const lease = await invoke<DirectoryWatchLease>("watch_directory", { path, sessionId });
  publishReadyDirectoryWatch(lease.path);
  return lease;
}

/**
 * Release the directory watch identified by an earlier acquisition.
 */
export async function unwatchDirectory(lease: DirectoryWatchLease): Promise<void> {
  const sessionId = await getNativeResourceSession();
  await invoke("unwatch_directory", { leaseId: lease.id, sessionId });
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
 * @returns Result with the committed path and optional entry metadata
 */
export async function createSymlink(
  targetPath: string,
  linkPath: string
): Promise<ApiResult<FileMutationReceipt>> {
  const guard = virtualPathGuard(targetPath, linkPath);
  if (guard) return guard;
  try {
    return await invokeFileMutation<FileMutationReceipt>("create_symlink", { targetPath, linkPath });
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
