/**
 * Shared drop handler logic for file drag-and-drop operations.
 * Extracted from FileItem.svelte and FileList.svelte to eliminate triplication.
 * Issue: tauri-explorer-9djf.1
 *
 * Delegates transfer logic to performFileTransfer (file-transfer.ts).
 */

import { parentDir, basename } from "$lib/domain/path";
import { dragState } from "./drag.svelte";
import { performFileTransfer } from "./file-transfer";
import { undoStore } from "./undo.svelte";
import { toastStore } from "./toast.svelte";
import { broadcastFileChange } from "./file-events";
import { frecencyStore } from "./frecency.svelte";
import type { UndoAction } from "./types";

export interface DropOptions {
  /** Refresh callback after drop completes */
  onRefresh: () => void;
  /** Broadcast undo/toast to other windows (for cross-window DnD) */
  broadcastToOtherWindows?: boolean;
  /** Names already present in the target dir, for conflict detection without
   *  a directory fetch. handleFileDropMany extends it as items land so later
   *  same-named items in the batch still hit the conflict dialog. */
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
  await performFileTransfer(sourcePath, targetDir, isCopy, {
    onRefresh: options.onRefresh,
    broadcastToOtherWindows: options.broadcastToOtherWindows,
    existingNames: options.existingNames,
  });
}

/**
 * Handle dropping several files/folders onto a target directory as ONE
 * undoable operation (#163). Each path transfers with per-item side effects
 * suppressed; the batch then records a single undo action, one toast, one
 * refresh, and one file-change broadcast. A single path delegates to
 * handleFileDrop unchanged.
 */
export async function handleFileDropMany(
  sourcePaths: string[],
  targetDir: string,
  isCopy: boolean,
  options: DropOptions,
): Promise<void> {
  if (sourcePaths.length === 0) return;
  if (sourcePaths.length === 1) {
    await handleFileDrop(sourcePaths[0], targetDir, isCopy, options);
    return;
  }

  const actions: UndoAction[] = [];
  const affectedDirs = new Set<string>([targetDir]);
  let failed = 0;
  let lastError: string | undefined;

  for (const sourcePath of sourcePaths) {
    const result = await performFileTransfer(sourcePath, targetDir, isCopy, {
      onRefresh: options.onRefresh,
      existingNames: options.existingNames,
      suppressUndo: true,
      suppressToast: true,
      suppressRefresh: true,
      suppressBroadcast: true,
    });
    if (!result.ok) {
      // "skipped" is a user choice (conflict dialog) or a same-parent no-op,
      // not a failure worth reporting.
      if (result.error !== "skipped") {
        failed++;
        lastError = result.error;
      }
      continue;
    }
    affectedDirs.add(parentDir(sourcePath));
    // Later items in this batch sharing the landed name must still conflict.
    options.existingNames?.add(basename(result.entry!.path));
    actions.push(
      isCopy
        ? { type: "copy", copiedPath: result.entry!.path, parentDir: targetDir }
        : {
            type: "move",
            sourcePath,
            destPath: result.entry!.path,
            originalDir: parentDir(sourcePath),
          },
    );
  }

  const verb = isCopy ? "Copied" : "Moved";
  if (actions.length > 0) {
    const label = `${verb} ${actions.length} items`;
    const action: UndoAction =
      actions.length === 1 ? actions[0] : { type: "batch", actions, label };
    if (options.broadcastToOtherWindows) {
      undoStore.pushAndBroadcast(action);
    } else {
      undoStore.push(action);
    }

    const message = `${verb} ${actions.length} item${actions.length === 1 ? "" : "s"} to ${basename(targetDir)}`;
    toastStore.show(message, "info");
    if (options.broadcastToOtherWindows) {
      toastStore.broadcast(message, "info");
    }

    options.onRefresh();
    broadcastFileChange([...affectedDirs]);
    frecencyStore.pruneNonExistent();
  }

  if (failed > 0) {
    toastStore.error(
      failed === 1 && lastError
        ? lastError
        : `Failed to ${isCopy ? "copy" : "move"} ${failed} item${failed === 1 ? "" : "s"}`,
    );
  }
}

