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

/** Advanced when a drag drops, ends or leaves the window: every folder's
 * feedback from earlier belongs to a finished gesture. A leave never reaches
 * a surface that unmounted first (a closing spring-loaded peek, #1242). */
let feedbackEpoch = $state(0);
export function retireDropFeedback(): void { feedbackEpoch++; }

/** The listing background's own drop highlight (`.content.drop-target`),
 * gated on the same epoch: a folder drop stops at its row, so the background
 * never sees a drop or leave of its own (#1269). */
export function useBackgroundDropFeedback() {
  let on = $state(false);
  let epoch = $state(feedbackEpoch);
  return {
    get active(): boolean { return on && epoch === feedbackEpoch; },
    set(value: boolean): void { on = value; epoch = feedbackEpoch; },
  };
}

export function useDropTarget(deps: DropTargetDeps) {
  let dropTargets = $state<Record<string, boolean>>({});
  let copyDropTargets = $state<Record<string, boolean>>({});
  /** The gesture the recorded feedback belongs to. */
  let epoch = feedbackEpoch;

  function handleDragOver(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    if (!dragState.acceptsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    const copying = isCopyModifier(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    if (epoch !== feedbackEpoch) { dropTargets = {}; copyDropTargets = {}; epoch = feedbackEpoch; }
    dropTargets[entry.path] = true;
    copyDropTargets[entry.path] = copying;
  }

  // A drag released right after crossing into a child of the row (icon, name)
  // has seen dragenter for that element but no dragover yet. WebKit delivers
  // `drop` only to a target whose dragenter was accepted, so accept both.
  const handleDragEnter = handleDragOver;

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

  /** Retire one folder's feedback without a leave event: the pointer moved onto
   * a nested element that is its own target or none (a List card's rows). */
  function releaseDropTarget(path: string): void {
    if (dropTargets[path]) dropTargets[path] = false;
    if (copyDropTargets[path]) copyDropTargets[path] = false;
  }

  function isDropTarget(path: string): boolean {
    return epoch === feedbackEpoch && (dropTargets[path] ?? false);
  }

  function isCopyDrop(path: string): boolean {
    return epoch === feedbackEpoch && (copyDropTargets[path] ?? false);
  }

  return {
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    releaseDropTarget,
    isDropTarget,
    isCopyDrop,
  };
}
