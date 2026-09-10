/**
 * Shared drop handler logic for file drag-and-drop operations.
 *
 * A drop is one ordered native session — copy or move — so conflict pauses,
 * cancellation, the completed prefix and the inverse are all native-owned.
 * `existingNames` is no longer consulted: the session inspects the real
 * destination per item, which a renderer name set cannot do correctly once
 * earlier items in the same batch have landed.
 */

import { dragState } from "./drag.svelte";

export interface DropOptions {
  /** Refresh callback after drop completes */
  onRefresh: () => void;
  /** Broadcast undo/toast to other windows (for cross-window DnD) */
  broadcastToOtherWindows?: boolean;
  /** Retained for callers; native inspection is the conflict authority. */
  existingNames?: Set<string>;
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
  await handleFileDropMany([sourcePath], targetDir, isCopy, options);
}

/**
 * Handle dropping several files/folders onto a target directory as ONE
 * undoable operation (#163): one native session, one history entry, one
 * toast, one refresh and one file-change broadcast.
 */
export async function handleFileDropMany(
  sourcePaths: string[],
  targetDir: string,
  isCopy: boolean,
  options: DropOptions,
): Promise<void> {
  if (sourcePaths.length === 0) return;
  const context = {
    onRefresh: options.onRefresh,
    broadcastToOtherWindows: options.broadcastToOtherWindows,
  };
  if (isCopy) {
    const { copyFiles } = await import("./copy-operations");
    await copyFiles(sourcePaths, targetDir, context);
    return;
  }
  const { moveFiles } = await import("./move-operations");
  await moveFiles(sourcePaths, targetDir, context);
}
