/**
 * API client for file operations.
 * Issue: tauri-explorer-nv2y - Migrated from Python FastAPI to Rust Tauri commands
 *
 * Concern-focused modules split out of this file live alongside it and are
 * re-exported at the bottom, so existing importers of `$lib/api/files` keep
 * working unchanged (Issue: refactor/audit-tier4-splits (#212)).
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import {
  invoke,
  extractError,
  virtualPathGuard,
  dataUriToBlobUrl,
  type ApiResult,
} from "./common";
import { providerFor } from "$lib/plugins/fs-providers";

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

/**
 * Open a file in the system's default application.
 *
 * @param path - Full path to file to open
 * @returns Result indicating success or error message
 */
export async function openFile(path: string): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    await invoke("open_file", { path });
    return { ok: true, data: undefined };
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
 * Open a file at a specific line number using a known text editor.
 * Falls back to default open if no known editor is found.
 */
export async function openFileAtLine(path: string, line: number): Promise<ApiResult<void>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
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
  const guard = virtualPathGuard(path);
  if (guard) return guard;
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
  const guard = virtualPathGuard(path);
  if (guard) return guard;
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
 * List terminal emulators that are actually installed on this machine, so the
 * settings UI can offer a dropdown instead of a free-text command.
 */
export async function listInstalledTerminals(): Promise<ApiResult<string[]>> {
  try {
    const data = await invoke<string[]>("list_installed_terminals");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Set an explicit ffmpeg binary path for video/audio thumbnails (empty string
 * clears it and reverts to auto-detection). Best-effort; ignores errors.
 */
export async function setFfmpegPath(path: string): Promise<void> {
  try {
    await invoke("set_ffmpeg_path", { path });
  } catch {
    // Not in Tauri runtime or command unavailable — ignore.
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
  try {
    const content = await invoke<string>("read_text_file", { path, maxBytes: maxBytes ?? null });
    return { ok: true, data: content };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
  try {
    const dataUri = await invoke<string>("read_image_data_url", {
      path,
      maxBytes: maxBytes ?? null,
    });
    return { ok: true, data: dataUriToBlobUrl(dataUri) };
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

/** Directory holding the app's rolling log files (for "open log folder"). */
export async function getLogDir(): Promise<string> {
  return invoke<string>("get_log_dir");
}

/**
 * Report a webview startup-timing summary to the app log (fire-and-forget
 * telemetry). Absent in mock/browser mode, where the promise rejects.
 */
export async function logStartupTiming(summary: string): Promise<void> {
  return invoke<void>("log_startup_timing", { summary });
}

export type DriveKind = "fixed" | "removable" | "network" | "cloud" | "unknown";

export type CloudProvider = "googledrive" | "wsl";

export interface Drive {
  name: string;
  path: string;
  kind: DriveKind;
  /** Secondary/dimmed label (e.g. the drive letter "E:" when name is the volume label). */
  detail?: string;
  /** Set for cloud/remote drives — selects the sidebar icon. */
  provider?: CloudProvider;
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
  // Virtual paths never stream: the provider returns the full listing inline
  // (listing_id null), which the caller treats as a non-streaming result.
  const provider = providerFor(path);
  if (provider) {
    try {
      const data = await provider.list(path);
      return { ok: true, data: { ...data, listing_id: null } };
    } catch (err) {
      return { ok: false, error: extractError(err) };
    }
  }
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
// Upscale (fal.ai SeedVR2)
// Issue: #276
// ===================

/**
 * Start a SeedVR2 image upscale job.
 * Returns job ID immediately; listen for upscale-complete/error events.
 */
export async function startUpscaleJob(
  sourcePath: string,
  outputDir: string,
  outputFilename: string,
  apiKey: string,
  upscaleFactor: number,
): Promise<ApiResult<number>> {
  try {
    const jobId = await invoke<number>("start_upscale_job", {
      sourcePath,
      outputDir,
      outputFilename,
      apiKey,
      upscaleFactor,
    });
    return { ok: true, data: jobId };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** File-picker portal window → backend: deliver the user's choice.
 *  `paths` are absolute filesystem paths; `cancelled` aborts the request. */
export async function pickerRespond(
  token: string,
  paths: string[],
  cancelled: boolean,
): Promise<void> {
  try {
    await invoke("picker_respond", { token, paths, cancelled });
  } catch {
    // Browser/mock mode — the e2e mock records the call instead.
  }
}

export async function setWindowTheme(theme: "light" | "dark"): Promise<void> {
  try {
    await invoke<void>("set_window_theme", { theme });
  } catch {
    // Non-critical — only affects vibrancy appearance
  }
}

// ===================
// Concern-focused re-exports (façade)
// Issue: refactor/audit-tier4-splits (#212)
//
// Split out of this file into cohesive modules; re-exported here so existing
// importers of `$lib/api/files` continue to resolve every symbol unchanged.
// ===================

export {
  invoke,
  extractError,
  extractErrorKind,
  type AppError,
  type AppErrorKind,
  type ApiResult,
} from "./common";

export * from "./search";
export * from "./thumbnails";
export * from "./archive";
export * from "./config";
export * from "./git";
export * from "./warm-pool";
