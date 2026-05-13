/**
 * Lightweight pointer-drag for sidebar items (Recent, etc.) on macOS.
 * Only supports dragging to the Bookmarks section (sidebar drop target).
 */

import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "./use-native-drop-target.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

const THRESHOLD_PX = 5;

export function useSidebarDrag() {
  let dragActive = false;
  let dragPath = "";
  let dragName = "";
  let startX = 0;
  let startY = 0;
  let ghostEl: HTMLElement | null = null;

  function handlePointerDown(event: MouseEvent, path: string, name: string): void {
    if (event.button !== 0) return;
    dragPath = path;
    dragName = name;
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
      ghostEl = createGhost(dragName);
    }

    const zoom = settingsStore.zoomLevel / 100;
    ghostEl!.style.left = `${(event.clientX + 12) / zoom}px`;
    ghostEl!.style.top = `${(event.clientY + 12) / zoom}px`;

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
    if (clearDrag) dragState.clear();
    dragActive = false;
    dragPath = "";
    dragName = "";
  }

  return { handlePointerDown };
}

function createGhost(name: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pointer-drag-ghost";
  el.textContent = name;
  el.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 9999;
    background: var(--surface-elevated, #2a2a2a);
    border: 1px solid var(--border-subtle, #444);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 13px;
    font-family: inherit;
    color: var(--text-primary, #eee);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    opacity: 0.92;
    white-space: nowrap;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  `;
  document.body.appendChild(el);
  return el;
}
