/**
 * API client for file operations.
 * Issue: tauri-explorer-nv2y - Migrated from Python FastAPI to Rust Tauri commands
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri, mockInvoke } from "./mock-invoke";

// Cached Tauri detection. Only the positive result is latched: an invoke
// racing ahead of __TAURI_INTERNALS__ injection must not permanently stick
// the real app on the mock, so we re-detect until Tauri is found.
let cachedIsTauri = false;

/**
 * Mock-aware invoke: dispatches to the real Tauri IPC when available,
 * otherwise to the in-memory mock (browser E2E). All API modules should use
 * this instead of importing `invoke` from @tauri-apps/api directly.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!cachedIsTauri && isTauri()) {
    cachedIsTauri = true;
  }
  const invoker = cachedIsTauri ? tauriInvoke<T> : mockInvoke<T>;
  return args !== undefined ? invoker(cmd, args) : invoker(cmd);
}

/** Structured error from Tauri backend */
export type AppErrorKind = "not_found" | "permission_denied" | "already_exists" | "invalid_path" | "io" | "other";

export interface AppError {
  kind: AppErrorKind;
  message: string;
}

const APP_ERROR_KINDS: ReadonlySet<string> = new Set<AppErrorKind>([
  "not_found", "permission_denied", "already_exists", "invalid_path", "io", "other",
]);

/** Extract error message from Tauri command error (structured or string) */
function extractError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
    // Plain object without a usable message — serialize rather than "[object Object]"
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Extract structured error kind from Tauri command error.
 *  Returns null unless the kind is a known AppErrorKind. */
export function extractErrorKind(err: unknown): AppErrorKind | null {
  if (err && typeof err === "object" && "kind" in err) {
    const kind = (err as { kind: unknown }).kind;
    if (typeof kind === "string" && APP_ERROR_KINDS.has(kind)) {
      return kind as AppErrorKind;
    }
  }
  return null;
}

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
  overwrite = false
): Promise<ApiResult<FileEntry>> {
  try {
    const data = await invoke<FileEntry>("copy_entry", { source, destDir, overwrite });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
  try {
    const data = await invoke<FileEntry>("move_entry", { source, destDir, overwrite });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open a file at a specific line number using a known text editor.
 * Falls back to default open if no known editor is found.
 */
export async function openFileAtLine(path: string, line: number): Promise<ApiResult<void>> {
  try {
    await invoke("open_file_at_line", { path, line });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open a file with a specific application.
 *
 * @param path - Full path to file to open
 * @param app - Application command to open with
 * @returns Result indicating success or error message
 */
export async function openFileWith(path: string, app: string): Promise<ApiResult<void>> {
  try {
    await invoke("open_file_with", { path, app });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open an image file with sibling images passed to the viewer,
 * enabling arrow-key navigation in viewers like imv, feh, etc.
 */
export async function openImageWithSiblings(path: string): Promise<ApiResult<void>> {
  try {
    await invoke("open_image_with_siblings", { path });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Open a terminal at a directory path.
 *
 * @param path - Path (directory or file, uses parent for files)
 * @returns Result indicating success or error message
 */
export async function openInTerminal(path: string, terminal?: string): Promise<ApiResult<void>> {
  try {
    await invoke("open_in_terminal", { path, terminal: terminal || null });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
  try {
    const content = await invoke<string>("read_text_file", { path, maxBytes: maxBytes ?? null });
    return { ok: true, data: content };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Get the working directory the app was launched from.
 */
export async function getLaunchCwd(): Promise<ApiResult<string>> {
  try {
    const path = await invoke<string>("get_launch_cwd");
    return { ok: true, data: path };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export type DriveKind = "fixed" | "removable" | "network" | "unknown";

export interface Drive {
  name: string;
  path: string;
  kind: DriveKind;
}

export async function listDrives(): Promise<ApiResult<Drive[]>> {
  try {
    const drives = await invoke<Drive[]>("list_drives");
    return { ok: true, data: drives };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
    return { ok: false, error: extractError(err) };
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
    return { ok: false, error: extractError(err) };
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
  try {
    await invoke("watch_directory", { path });
  } catch {
    // Non-critical: watcher failure shouldn't block navigation
  }
}

/**
 * Stop watching a directory. Decrements refcount; OS watch removed at zero.
 */
export async function unwatchDirectory(path: string): Promise<void> {
  try {
    await invoke("unwatch_directory", { path });
  } catch {
    // Non-critical
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
    return { ok: false, error: extractError(err) };
  }
}

function dataUriToBlobUrl(dataUri: string): string {
  const comma = dataUri.indexOf(",");
  if (comma === -1) return dataUri;
  const meta = dataUri.slice(0, comma);
  const mimeMatch = meta.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const raw = atob(dataUri.slice(comma + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/**
 * Get thumbnail as blob URL.
 *
 * @param path - Full path to image file
 * @param size - Optional thumbnail size (default 128)
 * @returns Result with blob URL or error
 */
export async function getThumbnailData(
  path: string,
  size?: number,
  quality?: number
): Promise<ApiResult<string>> {
  try {
    const dataUri = await invoke<string>("get_thumbnail_data", { path, size, quality });
    return { ok: true, data: dataUriToBlobUrl(dataUri) };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Get micro thumbnail (16x16) as blob URL for progressive loading.
 * Also pre-warms the full thumbnail cache as a side effect.
 *
 * @param path - Full path to image file
 * @returns Result with blob URL or error
 */
export async function getMicroThumbnail(
  path: string,
  prewarmSize?: number,
  prewarmQuality?: number
): Promise<ApiResult<string>> {
  try {
    const dataUri = await invoke<string>("get_micro_thumbnail", { path, prewarmSize, prewarmQuality });
    return { ok: true, data: dataUriToBlobUrl(dataUri) };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
    return { ok: false, error: extractError(err) };
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
 * Start a streaming content search using ripgrep.
 * Listen for 'content-search-results' events to receive results.
 *
 * @param query - Search query (text or regex pattern)
 * @param root - Root directory to search in
 * @param caseSensitive - Whether search is case-sensitive
 * @param regexMode - Whether to treat query as regex pattern
 * @param maxResults - Maximum number of results
 * @returns Result with search ID or error message
 */
export async function startContentSearch(
  query: string,
  root: string,
  caseSensitive: boolean = false,
  regexMode: boolean = false,
  maxResults: number = 500
): Promise<ApiResult<number>> {
  try {
    const searchId = await invoke<number>("start_content_search", {
      query,
      root,
      caseSensitive,
      regexMode,
      maxResults,
    });
    return { ok: true, data: searchId };
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
  try {
    const data = await invoke<FileEntry>("create_symlink", { targetPath, linkPath });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ===================
// Clipboard Image Paste
// Issue: tauri-ttbb
// ===================

/**
 * Check if the OS clipboard contains image data.
 */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    return await invoke<boolean>("clipboard_has_image");
  } catch {
    return false;
  }
}

/**
 * Paste clipboard image to a file in the given directory.
 *
 * @param directory - Directory to save the image in
 * @returns Result with the created file path or error
 */
export async function clipboardPasteImage(directory: string): Promise<ApiResult<string>> {
  try {
    const path = await invoke<string>("clipboard_paste_image", { directory });
    return { ok: true, data: path };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ===================
// Wallpaper
// Issue: tauri-explorer-mj32
// ===================

/**
 * Set an image file as the desktop wallpaper.
 * Auto-detects DE (Hyprland/hyprpaper, Sway, GNOME, KDE, XFCE, feh).
 *
 * @param path - Full path to image file
 * @returns Result indicating success or error message
 */
export async function setAsWallpaper(path: string): Promise<ApiResult<void>> {
  try {
    await invoke("set_as_wallpaper", { path });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ===================
// Nano Banana (AI Image Editing)
// Issue: feat/nano-banana
// ===================

/**
 * Start a Nano Banana image editing job.
 * Returns job ID immediately; listen for nano-banana-complete/error events.
 */
export async function startNanoBananaJob(
  sourcePath: string,
  prompt: string,
  outputDir: string,
  outputFilename: string,
  apiKey: string,
  model: string,
): Promise<ApiResult<number>> {
  try {
    const jobId = await invoke<number>("start_nano_banana_job", {
      sourcePath,
      prompt,
      outputDir,
      outputFilename,
      apiKey,
      model,
    });
    return { ok: true, data: jobId };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ===================
// Archive Operations
// Issue: tauri-explorer-0xr, tauri-explorer-kez
// ===================

/**
 * Compress files/directories into a ZIP archive.
 *
 * @param paths - List of file/directory paths to compress
 * @returns Result with path to created ZIP file or error
 */
export async function compressToZip(paths: string[]): Promise<ApiResult<string>> {
  try {
    const zipPath = await invoke<string>("compress_to_zip", { paths });
    return { ok: true, data: zipPath };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Extract a ZIP archive.
 *
 * @param archivePath - Path to the archive file
 * @param extractHere - If true, extract to archive's directory; if false, extract to new folder
 * @returns Result with extraction destination path or error
 */
export async function extractArchive(
  archivePath: string,
  extractHere: boolean = false
): Promise<ApiResult<string>> {
  try {
    const destPath = await invoke<string>("extract_archive", { archivePath, extractHere });
    return { ok: true, data: destPath };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ===================
// Config File Persistence
// Issue: tauri-ti0l
// ===================

/**
 * Read a JSON config file from the app config directory.
 * Returns empty string if file doesn't exist.
 */
export async function readConfigFile(filename: string): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("read_config_file", { filename });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Write a JSON config file to the app config directory.
 */
export async function writeConfigFile(filename: string, data: string): Promise<ApiResult<void>> {
  try {
    await invoke("write_config_file", { filename, data });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * List user theme CSS files from ~/.config/tauri-explorer/themes/.
 * Returns array of [filename, cssContent] pairs.
 */
export async function listUserThemes(): Promise<ApiResult<[string, string][]>> {
  try {
    const data = await invoke<[string, string][]>("list_user_themes");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Git file status types.
 */
export type GitFileStatus = "Modified" | "Added" | "Deleted" | "Renamed" | "Untracked" | "Ignored" | "Conflict";

export interface GitStatusResponse {
  is_git_repo: boolean;
  statuses: Record<string, GitFileStatus>;
}

/**
 * Get git status for files in a directory.
 */
export async function getGitStatus(path: string): Promise<ApiResult<GitStatusResponse>> {
  try {
    const data = await invoke<GitStatusResponse>("get_git_status", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ----- SCM git backend (#53) ----- //

export type GitStatusCode =
  | "Modified"
  | "Added"
  | "Deleted"
  | "Renamed"
  | "Copied"
  | "Untracked"
  | "Ignored"
  | "Conflict"
  | "TypeChange";

export interface GitFileEntry {
  path: string;
  old_path: string | null;
  status: GitStatusCode;
}

export interface GitStatusSummary {
  is_repo: boolean;
  repo_root: string | null;
  branch: string | null;
  detached: boolean;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  untracked: GitFileEntry[];
  merge: GitFileEntry[];
}

export interface GitCommitResult {
  commit_id: string;
  summary: string;
}

export async function gitInit(path: string): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("git_init", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitRepoRoot(path: string): Promise<ApiResult<string | null>> {
  try {
    const data = await invoke<string | null>("git_repo_root", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Append a path to the repo's `.gitignore`, creating the file if needed.
 *  Idempotent — duplicate entries are skipped. */
export async function gitAddToGitignore(
  repoRoot: string,
  entry: string,
): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("git_add_to_gitignore", { repoRoot, entry });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitSummary(repoPath: string): Promise<ApiResult<GitStatusSummary>> {
  try {
    const data = await invoke<GitStatusSummary>("git_status", { repoPath });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitStage(repoPath: string, paths: string[]): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_stage", { repoPath, paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitUnstage(repoPath: string, paths: string[]): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_unstage", { repoPath, paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitDiscard(
  repoPath: string,
  paths: string[],
  options?: { force?: boolean },
): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_discard", { repoPath, paths, options: options ?? null });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitDiff(
  repoPath: string,
  path: string,
  options?: { staged?: boolean },
): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("git_diff", { repoPath, path, options: options ?? null });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitCommit(
  repoPath: string,
  message: string,
  options?: { amend?: boolean },
): Promise<ApiResult<GitCommitResult>> {
  try {
    const data = await invoke<GitCommitResult>("git_commit", { repoPath, message, options: options ?? null });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitWatchRepo(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_watch_repo", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitUnwatchRepo(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_unwatch_repo", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function setWindowTheme(theme: "light" | "dark"): Promise<void> {
  try {
    await invoke<void>("set_window_theme", { theme });
  } catch {
    // Non-critical — only affects vibrancy appearance
  }
}
