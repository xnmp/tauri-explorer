/**
 * Composable for drop-target behavior on directory entries.
 * Shared by useItemInteractions (main views) and MillerColumns.
 * Issue: refactor/extract-drop-target
 */

import type { FileEntry } from "$lib/domain/file";
import { isMac, isCopyModifier } from "$lib/domain/platform";
import { dragState } from "$lib/state/drag.svelte";
import { getDropSourcePaths, handleFileDrop } from "$lib/state/drop-operations";

interface DropTargetDeps {
  /** Called after a successful drop to refresh the UI */
  onRefresh: () => void;
}

export function useDropTarget(deps: DropTargetDeps) {
  let dropTargets = $state<Record<string, boolean>>({});
  let copyDropTargets = $state<Record<string, boolean>>({});

  function handleDragOver(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    const types = event.dataTransfer?.types;
    if (!types?.includes("application/x-explorer-path") && !types?.includes("Files") && !dragState.readCrossWindow()) return;
    event.preventDefault();
    const copying = isCopyModifier(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    dropTargets[entry.path] = true;
    copyDropTargets[entry.path] = copying;
  }

  function handleDragLeave(entry: FileEntry): void {
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;
  }

  async function handleDrop(event: DragEvent, entry: FileEntry): Promise<void> {
    event.preventDefault();
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;

    if (entry.kind !== "directory" || !event.dataTransfer) return;

    const sourcePaths = getDropSourcePaths(event.dataTransfer);
    if (sourcePaths.length === 0) return;

    const isCopy = isCopyModifier(event);

    dragState.clear();

    for (const sourcePath of sourcePaths) {
      if (sourcePath === entry.path) continue;
      if (entry.path.startsWith(sourcePath + "/")) continue;
      await handleFileDrop(sourcePath, entry.path, isCopy, {
        onRefresh: deps.onRefresh,
      });
    }
  }

  function isDropTarget(path: string): boolean {
    return dropTargets[path] ?? false;
  }

  function isCopyDrop(path: string): boolean {
    return copyDropTargets[path] ?? false;
  }

  return {
    handleDragOver,
    handleDragLeave,
    handleDrop,
    isDropTarget,
    isCopyDrop,
  };
}
