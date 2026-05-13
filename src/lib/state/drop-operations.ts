/**
 * Shared drop handler logic for file drag-and-drop operations.
 * Extracted from FileItem.svelte and FileList.svelte to eliminate triplication.
 * Issue: tauri-explorer-9djf.1
 *
 * Delegates transfer logic to performFileTransfer (file-transfer.ts).
 */

import { parentDir } from "$lib/domain/path";
import { dragState } from "./drag.svelte";
import { performFileTransfer } from "./file-transfer";

export interface DropOptions {
  /** Refresh callback after drop completes */
  onRefresh: () => void;
}

/**
 * Extract the source path from a drop event, trying dataTransfer first,
 * then falling back to cross-window drag state.
 */
export function getDropSourcePath(dataTransfer: DataTransfer): string | null {
  let sourcePath = dataTransfer.getData("application/x-explorer-path");
  if (!sourcePath) {
    const crossWindow = dragState.readCrossWindow();
    if (crossWindow) sourcePath = crossWindow.path;
  }
  return sourcePath || null;
}

/**
 * Extract all source paths from a drop event (supports multi-file drag).
 * Falls back to single path if multi-paths data is not available.
 */
export function getDropSourcePaths(dataTransfer: DataTransfer): string[] {
  const multiPaths = dataTransfer.getData("application/x-explorer-paths");
  if (multiPaths) {
    try {
      const parsed = JSON.parse(multiPaths);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* ignore parse errors */ }
  }
  // Check dragState for multi-paths (cross-window internal drags)
  const crossWindow = dragState.readCrossWindow();
  if (crossWindow?.paths && crossWindow.paths.length > 0) return crossWindow.paths;

  // Fallback to single path
  const single = getDropSourcePath(dataTransfer);
  return single ? [single] : [];
}

/**
 * Handle dropping a file/folder onto a target directory.
 * Delegates to performFileTransfer for conflict resolution, dispatch,
 * undo tracking, toast notifications, and broadcastFileChange.
 */
export async function handleFileDrop(
  sourcePath: string,
  targetDir: string,
  isCopy: boolean,
  options: DropOptions,
): Promise<void> {
  await performFileTransfer(sourcePath, targetDir, isCopy, {
    onRefresh: options.onRefresh,
  });
}

/**
 * Handle dropping a file onto the background of the current directory.
 * Only supports move (not copy), guards against same-directory drops.
 */
export async function handleBackgroundDrop(
  sourcePath: string,
  currentPath: string,
  existingNames: Set<string>,
  options: DropOptions,
): Promise<void> {
  const sourceDir = parentDir(sourcePath);
  if (sourceDir === currentPath) return;

  await performFileTransfer(sourcePath, currentPath, false, {
    onRefresh: options.onRefresh,
    existingNames,
  });
}
