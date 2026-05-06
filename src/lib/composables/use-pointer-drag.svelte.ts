/**
 * Pointer-event-based drag for macOS.
 *
 * On macOS, native NSDraggingSession (startExternalDrag) kills HTML5 DnD events.
 * This composable uses pointer events for same-window drag and triggers native
 * drag only when the cursor exits the window bounds (for external/cross-window).
 */

import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import type { PaneNavigationContext } from "$lib/state/pane-context";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { handleFileDrop, handleBackgroundDrop } from "$lib/state/drop-operations";
import { startExternalDrag } from "./use-external-drag.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "./use-native-drop-target.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

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
  let capturedTarget: HTMLElement | null = null;
  let pointerId: number | null = null;

  function refreshPanes(): void {
    const paneNav = deps.getPaneNav();
    if (paneNav) paneNav.refreshAllPanes();
    else deps.getExplorer().refresh({ silent: true });
  }

  function handlePointerDown(event: PointerEvent, entry: FileEntry, isSelected: boolean): void {
    if (event.button !== 0) return;

    const explorer = deps.getExplorer();
    const selectedEntries = explorer.getSelectedEntries();
    const isMulti = selectedEntries.length > 1 && isSelected;
    dragPaths = isMulti ? selectedEntries.map((e) => e.path) : [entry.path];

    startX = event.clientX;
    startY = event.clientY;
    dragActive = false;
    pointerId = event.pointerId;
    capturedTarget = event.currentTarget as HTMLElement;

    try { capturedTarget.setPointerCapture(event.pointerId); } catch {}

    const entryData = { path: entry.path, name: entry.name, kind: entry.kind, paths: isMulti ? dragPaths : undefined };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKeyDown);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("blur", onCancel);

    // Store entry data for use when threshold is met
    (onPointerMove as any)._entryData = entryData;
  }

  function onPointerMove(event: PointerEvent): void {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragActive) {
      if (Math.sqrt(dx * dx + dy * dy) < THRESHOLD_PX) return;
      dragActive = true;
      const entryData = (onPointerMove as any)._entryData;
      dragState.start(entryData);
      ghostEl = createGhost(dragPaths);
    }

    const zoom = settingsStore.zoomLevel / 100;
    ghostEl!.style.left = `${(event.clientX + 12) / zoom}px`;
    ghostEl!.style.top = `${(event.clientY + 12) / zoom}px`;

    // Exit window → hand off to native drag for external/cross-window.
    // With pointer capture, coords clamp to viewport bounds when pointer exits.
    // Log edge hits for debugging
    if (event.clientX <= 0 || event.clientX >= window.innerWidth - 1 ||
        event.clientY <= 0 || event.clientY >= window.innerHeight - 1) {
      console.debug("[pointer-drag] edge hit:", event.clientX, event.clientY, "viewport:", window.innerWidth, window.innerHeight);
    }
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

  function onPointerLeave(_event: PointerEvent): void {
    if (!dragActive || nativeStarted) return;
    nativeStarted = true;
    startNativeDrag();
  }

  function startNativeDrag(): void {
    clearHighlights();
    // Release pointer capture so OS can take over the mouse gesture
    if (capturedTarget && pointerId !== null) {
      try { capturedTarget.releasePointerCapture(pointerId); } catch {}
    }
    // Remove listeners so no more pointer events fire during native drag
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onKeyDown);
    document.documentElement.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("blur", onCancel);
    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }
    // Start native drag — dragState is intentionally NOT cleared so cross-window
    // target can detect this as an internal source via dragState.current
    const paths = [...dragPaths];
    dragActive = false;
    dragPaths = [];
    capturedTarget = null;
    pointerId = null;
    void startExternalDrag(paths);
  }

  async function onPointerUp(event: PointerEvent): Promise<void> {
    if (!dragActive) {
      cleanup(false);
      return;
    }

    clearHighlights();
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
      const sourceDir = dragPaths[0]?.substring(0, dragPaths[0].lastIndexOf("/"));
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

  function cleanup(clearDrag: boolean): void {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onKeyDown);
    document.documentElement.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("blur", onCancel);

    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }

    if (capturedTarget && pointerId !== null) {
      try { capturedTarget.releasePointerCapture(pointerId); } catch {}
    }

    if (clearDrag) dragState.clear();
    dragActive = false;
    nativeStarted = false;
    dragPaths = [];
    capturedTarget = null;
    pointerId = null;
  }

  return { handlePointerDown };
}

function createGhost(paths: string[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "pointer-drag-ghost";
  const name = paths[0].split("/").pop() || paths[0];
  el.textContent = paths.length > 1 ? `${paths.length} items` : name;
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
