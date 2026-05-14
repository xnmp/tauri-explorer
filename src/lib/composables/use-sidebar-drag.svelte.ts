/**
 * Lightweight pointer-drag for sidebar items (Recent, etc.) on macOS.
 * Only supports dragging to the Bookmarks section (sidebar drop target).
 */

import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "./use-native-drop-target.svelte";
import { createDragGhost } from "./use-pointer-drag.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

const THRESHOLD_PX = 5;

export function useSidebarDrag() {
  let dragActive = false;
  let dragPath = "";
  let dragName = "";
  let startX = 0;
  let startY = 0;
  let ghostEl: HTMLElement | null = null;

  let sourceEl: HTMLElement | null = null;

  function handlePointerDown(event: MouseEvent, path: string, name: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    dragPath = path;
    dragName = name;
    sourceEl = (event.currentTarget as HTMLElement) || null;
    startX = event.clientX;
    startY = event.clientY;
    dragActive = false;

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onCancel);
  }

  function onMouseMove(event: MouseEvent): void {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragActive) {
      if (Math.sqrt(dx * dx + dy * dy) < THRESHOLD_PX) return;
      dragActive = true;
      dragState.start({ path: dragPath, name: dragName, kind: "directory" });
      ghostEl = createDragGhost(sourceEl, dragName);
    }

    const zoom = settingsStore.zoomLevel / 100;
    const gw = ghostEl!.offsetWidth || 0;
    const gh = ghostEl!.offsetHeight || 0;
    ghostEl!.style.left = `${event.clientX / zoom - gw / 2}px`;
    ghostEl!.style.top = `${event.clientY / zoom - gh / 2}px`;

    highlightTargetAtPoint(event.clientX, event.clientY);
  }

  function onMouseUp(event: MouseEvent): void {
    if (!dragActive) {
      cleanup(false);
      return;
    }

    clearHighlights();
    if (ghostEl) ghostEl.style.display = "none";
    const target = resolveDropTargetAtPoint(event.clientX, event.clientY);

    if (target?.type === "sidebar") {
      bookmarksStore.addBookmark(dragPath, dragName);
    }

    cleanup(true);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && dragActive) {
      clearHighlights();
      cleanup(true);
    }
  }

  function onCancel(): void {
    if (dragActive) clearHighlights();
    cleanup(true);
  }

  function cleanup(clearDrag: boolean): void {
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", onCancel);
    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }
    sourceEl = null;
    if (clearDrag) dragState.clear();
    dragActive = false;
    dragPath = "";
    dragName = "";
  }

  return { handlePointerDown };
}

