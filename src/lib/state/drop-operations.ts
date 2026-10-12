/**
 * Shared drop handler logic for file drag-and-drop operations.
 *
 * A drop is one ordered native session — copy or move — so conflict pauses,
 * cancellation, the completed prefix and the inverse are all native-owned.
 Conflict detection belongs to the
 * session, which inspects the real destination per item — a renderer name
 * snapshot cannot do that correctly once earlier items in the batch land.
 */

import { dragState } from "./drag.svelte";
import { domDropPaths, internalDragPaths } from "$lib/domain/file-drop";
import { isWindows } from "$lib/domain/platform";

export interface DropOptions {
  /** Refresh callback after drop completes */
  onRefresh: () => void;
  /** Broadcast undo/toast to other windows (for cross-window DnD) */
  broadcastToOtherWindows?: boolean;
}

/**
 * Extract the source path from a drop event, trying dataTransfer first,
 * then falling back to cross-window drag state.
 */
export function getDropSourcePath(dataTransfer: DataTransfer): string | null {
  const paths = getDropSourcePaths(dataTransfer);
  const primary = dataTransfer.getData("application/x-explorer-path");
  return paths.includes(primary) ? primary : paths[0] ?? null;
}

/**
 * Extract all source paths from a drop event (supports multi-file drag).
 * Falls back to single path if multi-paths data is not available.
 */
export function getDropSourcePaths(dataTransfer: DataTransfer): string[] {
  if (dataTransfer.getData("application/x-explorer-paths") || dataTransfer.getData("application/x-explorer-path")) {
    return domDropPaths(dataTransfer, isWindows) ?? [];
  }
  // Hover admission alone proves no paths. domSource requires an Explorer
  // marker or an exact session-bearing URI payload; unbound native Files
  // cannot borrow a retained selection even while an internal drag is live.
  if (!dataTransfer.getData("application/x-explorer-kind") && !dragState.acceptsFileDrag(dataTransfer)) return [];
  return internalDragPaths(dragState.domSource(dataTransfer), isWindows) ?? [];
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
