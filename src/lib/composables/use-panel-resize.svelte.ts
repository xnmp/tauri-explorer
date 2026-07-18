/**
 * Persisted, drag-resizable panel width (#278).
 *
 * Extracted from three verbatim copies (Sidebar, ScmPanel, MillerColumns):
 * load a clamped width from storage, track a horizontal drag 1:1 with the
 * pointer, restore the body cursor/select state on release, and persist the
 * final width. Storage goes through persisted.ts — components must not touch
 * localStorage directly. Stored values written by the old copies were plain
 * numbers, which JSON-parse to the same numbers, so old widths carry over.
 */

import { onDestroy } from "svelte";
import { loadPersisted, savePersisted } from "$lib/state/persisted";

export interface PanelResizeOptions {
  min: number;
  max: number;
  default: number;
  /** Set when the handle sits on the panel's LEFT edge, so dragging left
      (negative dx) grows the panel instead of shrinking it. */
  invert?: boolean;
}

export interface PanelResize {
  /** Current width in px (reactive). */
  readonly width: number;
  /** True while a drag is in progress (reactive). */
  readonly isResizing: boolean;
  /** mousedown handler for the resize handle. */
  startResize: (event: MouseEvent) => void;
}

export function usePersistedPanelWidth(key: string, opts: PanelResizeOptions): PanelResize {
  const clamp = (w: number) => Math.max(opts.min, Math.min(opts.max, w));

  const saved = loadPersisted<unknown>(key, opts.default);
  const initial = typeof saved === "number" && Number.isFinite(saved) ? saved : opts.default;

  let width = $state(clamp(initial));
  let isResizing = $state(false);

  // Retained so onDestroy can detach a drag still in progress when the owning
  // component unmounts mid-resize — otherwise the document listeners and the
  // body cursor/select overrides leak for the rest of the session (#439).
  let activeMove: ((e: MouseEvent) => void) | null = null;
  let activeUp: (() => void) | null = null;

  function detachDrag(): void {
    if (activeMove) document.removeEventListener("mousemove", activeMove);
    if (activeUp) document.removeEventListener("mouseup", activeUp);
    activeMove = null;
    activeUp = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function startResize(event: MouseEvent): void {
    event.preventDefault();
    isResizing = true;

    const startX = event.clientX;
    const startWidth = width;

    function onMouseMove(e: MouseEvent) {
      const dx = e.clientX - startX;
      width = clamp(startWidth + (opts.invert ? -dx : dx));
    }

    function onMouseUp() {
      isResizing = false;
      savePersisted(key, width);
      detachDrag();
    }

    activeMove = onMouseMove;
    activeUp = onMouseUp;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }

  // Cleanup if the component unmounts mid-drag (before onMouseUp fires).
  // Wrapped so callers that use this outside component init (e.g. unit tests)
  // don't throw, mirroring the sibling drag composables.
  try {
    onDestroy(detachDrag);
  } catch {
    /* not in component init */
  }

  return {
    get width() {
      return width;
    },
    get isResizing() {
      return isResizing;
    },
    startResize,
  };
}
