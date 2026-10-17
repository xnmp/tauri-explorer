/**
 * Drop feedback for a container surface (a List card's scroll area) whose
 * rows are their own drop targets (#1240). Moving from the surface onto a row
 * fires no leave on the surface, because the row is inside it, so the surface
 * must retire its own target when the pointer reaches a row or another folder.
 */
import type { FileEntry } from "$lib/domain/file";

/** The drop-target operations the surface forwards to (`useItemInteractions`). */
export interface SurfaceDropTargets {
  handleDragOver(event: DragEvent, entry: FileEntry): void;
  handleDragLeave(event: DragEvent, entry: FileEntry): void;
  handleDrop(event: DragEvent, entry: FileEntry): unknown;
  releaseDropTarget(path: string): void;
}

/** Minimal DOM surface of an event target, so resolution is testable in node. */
interface ClosestTarget {
  closest(selector: string): (ClosestTarget & { dataset?: DOMStringMap }) | null;
}

/**
 * The folder path a drop or menu on the surface (not a row) targets: the
 * innermost `.peek-drop-target[data-path]` (a nested folder's pseudo-row), or
 * `fallback`. Null over an entry row, which is its own target.
 */
export function surfaceDropPath(target: unknown, fallback: string): string | null {
  const element = target && typeof (target as ClosestTarget).closest === "function" ? target as ClosestTarget : null;
  if (!element || element.closest(".entry-item")) return null;
  return element.closest(".peek-drop-target[data-path]")?.dataset?.path || fallback;
}

/**
 * Tracks the folder whose surface shows drop feedback. `resolve` maps an
 * event to its folder (or null over a row); `getTargets` is read per event,
 * so a component can pass its current props.
 */
export function createSurfaceDropFeedback(getTargets: () => SurfaceDropTargets, resolve: (event: Event) => FileEntry | null) {
  let current: FileEntry | null = null;
  function retarget(next: FileEntry | null): void {
    if (current && current.path !== next?.path) getTargets().releaseDropTarget(current.path);
    current = next;
  }
  return {
    over(event: DragEvent): void {
      const folder = resolve(event);
      retarget(folder);
      if (folder) getTargets().handleDragOver(event, folder);
    },
    leave(event: DragEvent): void {
      if (current) getTargets().handleDragLeave(event, current);
    },
    drop(event: DragEvent): void {
      const folder = resolve(event);
      retarget(null);
      if (folder) void getTargets().handleDrop(event, folder);
    },
    /** The folder currently showing surface feedback. */
    get current(): FileEntry | null { return current; },
  };
}
