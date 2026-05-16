/**
 * Pointer-event-based drag for macOS.
 *
 * On macOS, native NSDraggingSession (startExternalDrag) kills HTML5 DnD events.
 * This composable uses mouse events for same-window drag and triggers native
 * drag only when the cursor exits the window bounds (for external/cross-window).
 *
 * Uses mousemove/mouseup on window (not pointer events with capture) because
 * implicit mouse capture in browsers reliably delivers events and accurate
 * coordinates even after the cursor leaves the viewport.
 */

import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import type { PaneNavigationContext } from "$lib/state/pane-context";
import { parentDir, basename } from "$lib/domain/path";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { handleFileDrop, handleBackgroundDrop } from "$lib/state/drop-operations";
import { startExternalDrag } from "./use-external-drag.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "./use-native-drop-target.svelte";
import { getZoomFactor } from "$lib/domain/zoom";

export interface PointerDragDeps {
  getExplorer: () => ExplorerInstance;
  getPaneNav: () => PaneNavigationContext | undefined;
}

const THRESHOLD_PX = 5;

export function usePointerDrag(deps: PointerDragDeps) {
  let dragActive = false;
  let nativeStarted = false;
  let dragPaths: string[] = [];
  let startX = 0;
  let startY = 0;
  let ghostEl: HTMLElement | null = null;
  let sourceEl: HTMLElement | null = null;
  let entryData: { path: string; name: string; kind: string; paths?: string[] } | null = null;

  function refreshPanes(): void {
    const paneNav = deps.getPaneNav();
    if (paneNav) paneNav.refreshAllPanes();
    else deps.getExplorer().refresh({ silent: true });
  }

  function handlePointerDown(event: MouseEvent, entry: FileEntry, isSelected: boolean): void {
    if (event.button !== 0) return;
    event.preventDefault();

    const explorer = deps.getExplorer();
    const selectedEntries = explorer.getSelectedEntries();
    const isMulti = selectedEntries.length > 1 && isSelected;
    dragPaths = isMulti ? selectedEntries.map((e) => e.path) : [entry.path];
    sourceEl = (event.currentTarget as HTMLElement) || null;

    startX = event.clientX;
    startY = event.clientY;
    dragActive = false;
    nativeStarted = false;
    entryData = { path: entry.path, name: entry.name, kind: entry.kind, paths: isMulti ? dragPaths : undefined };

    // Use mousemove/mouseup on window — implicit mouse capture ensures events
    // keep firing (with accurate coordinates) even after cursor leaves the viewport.
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onCancel);
  }

  function onMouseMove(event: MouseEvent): void {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragActive) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < THRESHOLD_PX) return;
      dragActive = true;
      dragState.start(entryData!);
      const fallback = dragPaths.length > 1 ? `${dragPaths.length} items` : basename(dragPaths[0]);
      ghostEl = createDragGhost(sourceEl, fallback);
    }

    const zoom = getZoomFactor();
    ghostEl!.style.left = `${event.clientX / zoom}px`;
    ghostEl!.style.top = `${event.clientY / zoom}px`;
    ghostEl!.style.transform = "translate(-50%, -50%)";
    // Exit window → hand off to native drag for external/cross-window.
    // With implicit mouse capture, clientX/Y extends beyond viewport bounds.
    if (
      !nativeStarted && (
        event.clientX <= 0 ||
        event.clientX >= window.innerWidth - 1 ||
        event.clientY <= 0 ||
        event.clientY >= window.innerHeight - 1
      )
    ) {
      nativeStarted = true;
      startNativeDrag();
      return;
    }

    if (!nativeStarted) {
      highlightTargetAtPoint(event.clientX, event.clientY);
    }
  }

  function startNativeDrag(): void {
    clearHighlights();
    removeListeners();
    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }
    const paths = [...dragPaths];
    dragActive = false;
    dragPaths = [];
    entryData = null;
    void startExternalDrag(paths);
  }

  async function onMouseUp(event: MouseEvent): Promise<void> {
    if (!dragActive) {
      cleanup(false);
      return;
    }

    clearHighlights();
    if (ghostEl) ghostEl.style.display = "none";
    const target = resolveDropTargetAtPoint(event.clientX, event.clientY);
    const isCopy = event.altKey;
    const explorer = deps.getExplorer();

    if (target?.type === "sidebar") {
      for (const p of dragPaths) {
        bookmarksStore.addBookmark(p);
      }
    } else if (target?.type === "folder") {
      const paths = [...dragPaths];
      const targetPath = target.path;
      cleanup(true);
      for (const sourcePath of paths) {
        if (sourcePath === targetPath) continue;
        if (targetPath.startsWith(sourcePath + "/")) continue;
        await handleFileDrop(sourcePath, targetPath, isCopy, { onRefresh: refreshPanes });
      }
      return;
    } else if (target?.type === "background") {
      const destPath = target.path || explorer.currentPath;
      const sourceDir = dragPaths[0] ? parentDir(dragPaths[0]) : undefined;
      if (sourceDir !== destPath) {
        const paths = [...dragPaths];
        cleanup(true);
        for (const sourcePath of paths) {
          await handleBackgroundDrop(sourcePath, destPath, new Set(), { onRefresh: refreshPanes });
        }
        return;
      }
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

  function removeListeners(): void {
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", onCancel);
  }

  function cleanup(clearDrag: boolean): void {
    removeListeners();
    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }
    sourceEl = null;
    if (clearDrag) dragState.clear();
    dragActive = false;
    nativeStarted = false;
    dragPaths = [];
    entryData = null;
  }

  return { handlePointerDown };
}

export function createDragGhost(sourceEl?: HTMLElement | null, fallbackText?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pointer-drag-ghost";

  if (sourceEl) {
    const icon = sourceEl.querySelector<HTMLElement>("[data-drag-icon]");
    const name = sourceEl.querySelector<HTMLElement>("[data-drag-name]");
    if (icon) el.appendChild(icon.cloneNode(true));
    if (name) el.appendChild(name.cloneNode(true));
    if (!icon && !name) el.textContent = fallbackText || "";
  } else if (fallbackText) {
    el.textContent = fallbackText;
  }

  el.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    opacity: 0.85;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px;
    font-size: 13px;
    color: var(--text-primary, #eee);
    text-align: center;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  `;
  document.body.appendChild(el);
  return el;
}
