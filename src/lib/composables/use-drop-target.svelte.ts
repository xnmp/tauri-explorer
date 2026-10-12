/**
 * Composable for drop-target behavior on directory entries.
 * Shared by useItemInteractions (main views) and MillerColumns.
 * Issue: refactor/extract-drop-target
 */

import type { FileEntry } from "$lib/domain/file";
import { isCopyModifier } from "$lib/domain/platform";
import { dropIntoDirectory } from "./use-dom-directory-drop";
import { dragState } from "$lib/state/drag.svelte";

interface DropTargetDeps {
  /** Called after a successful drop to refresh the UI */
  onRefresh: () => void;
}

export function useDropTarget(deps: DropTargetDeps) {
  let dropTargets = $state<Record<string, boolean>>({});
  let copyDropTargets = $state<Record<string, boolean>>({});

  function handleDragOver(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    if (!dragState.acceptsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    const copying = isCopyModifier(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    dropTargets[entry.path] = true;
    copyDropTargets[entry.path] = copying;
  }

  function handleDragLeave(event: DragEvent, entry: FileEntry): void {
    // dragenter/dragleave pair per ELEMENT, not per subtree: moving the
    // cursor onto a child of the row fires dragleave on the row, and the
    // next dragover re-highlights it — a blink on every small move (#242).
    // Ignore leaves that stay inside the row: by relatedTarget when the
    // engine provides it, by coordinates otherwise (WebKit's dragleave
    // relatedTarget is null).
    const row = event.currentTarget as HTMLElement | null;
    if (row) {
      const related = event.relatedTarget as Node | null;
      if (related && row.contains(related)) return;
      if (!related && (event.clientX !== 0 || event.clientY !== 0)) {
        const r = row.getBoundingClientRect();
        if (
          event.clientX >= r.left && event.clientX < r.right &&
          event.clientY >= r.top && event.clientY < r.bottom
        ) return;
      }
    }
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;
  }

  async function handleDrop(event: DragEvent, entry: FileEntry): Promise<void> {
    if (!dragState.acceptsFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    // Item-level drops are fully handled here — never let them bubble to
    // background drop handlers (FileList content, Miller column background),
    // which would process the same drop a second time.
    event.stopPropagation();
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;

    if (entry.kind !== "directory" || !event.dataTransfer) return;

    await dropIntoDirectory(event, entry.path, "folder", { onRefresh: deps.onRefresh });
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
