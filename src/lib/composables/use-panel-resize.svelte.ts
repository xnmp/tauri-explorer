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

import { loadPersisted, savePersisted } from "$lib/state/persisted";

export interface PanelResizeOptions {
  min: number;
  max: number;
  default: number;
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

  function startResize(event: MouseEvent): void {
    event.preventDefault();
    isResizing = true;

    const startX = event.clientX;
    const startWidth = width;

    function onMouseMove(e: MouseEvent) {
      width = clamp(startWidth + (e.clientX - startX));
    }

    function onMouseUp() {
      isResizing = false;
      savePersisted(key, width);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
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
