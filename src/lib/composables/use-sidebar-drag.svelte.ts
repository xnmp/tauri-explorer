/**
 * Lightweight pointer-drag for sidebar items (Recent, etc.) on macOS.
 * Supports Bookmarks and registered plugin file drop targets.
 */

import { onDestroy } from "svelte";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "./use-native-drop-target.svelte";
import { createDragGhost } from "./use-pointer-drag.svelte";
import { settingsStore } from "$lib/state/settings.svelte";
import { dispatchFileDrop } from "$lib/state/dispatch-file-drop";
import { internalDragPaths } from "$lib/domain/file-drop";
import { isWindows } from "$lib/domain/platform";

const THRESHOLD_PX = 5;

export function useSidebarDrag() {
  let dragActive = false;
  let dragPath = "";
  let dragName = "";
  let startX = 0;
  let startY = 0;
  let ghostEl: HTMLElement | null = null;

  let sourceEl: HTMLElement | null = null;

  // Window listeners are added on pointerdown; if the owning component is
  // destroyed mid-drag they would otherwise leak for the rest of the session.
  try {
    onDestroy(() => {
      if (dragActive) clearHighlights();
      cleanup(dragActive);
    });
  } catch {
    // Not called during component init (e.g. unit tests) — caller manages lifetime.
  }

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
      dragState.start({ path: dragPath, name: dragName, kind: "directory", nativeCopyPolicy: "link" });
      ghostEl = createDragGhost(sourceEl, dragName);
    }

    const zoom = settingsStore.zoomLevel / 100;
    ghostEl!.style.left = `${event.clientX / zoom}px`;
    ghostEl!.style.top = `${event.clientY / zoom}px`;
    ghostEl!.style.transform = "translate(-50%, -50%)";

    highlightTargetAtPoint(event.clientX, event.clientY);
    const target = resolveDropTargetAtPoint(event.clientX, event.clientY);
    document.body.style.cursor = target?.type === "sidebar" || target?.type === "bookmark" || target?.type === "plugin" ? "copy" : "not-allowed";
  }

  async function onMouseUp(event: MouseEvent): Promise<void> {
    if (!dragActive) {
      cleanup(false);
      return;
    }

    if (ghostEl) ghostEl.style.display = "none";
    const target = resolveDropTargetAtPoint(event.clientX, event.clientY);
    const data = dragState.current;
    const path = dragPath;
    const name = dragName;
    cleanup(false);
    const delivery = dispatchFileDrop(target, internalDragPaths(data, isWindows) ?? [], "pane", data);
    if (delivery) { await delivery; return; }
    clearHighlights();

    if (target?.type === "sidebar" || target?.type === "bookmark") {
      bookmarksStore.addBookmark(path, name);
    }

    dragState.finish(data);
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
    document.body.style.cursor = "";
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

