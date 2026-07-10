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

import { onDestroy } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { parentDir, basename, isInsideDir, samePath } from "$lib/domain/path";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { handleFileDropMany } from "$lib/state/drop-operations";
import { startExternalDrag } from "./use-external-drag.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "./use-native-drop-target.svelte";
import { getZoomFactor } from "$lib/domain/zoom";

export interface PointerDragDeps {
  getExplorer: () => ExplorerInstance;
  /** Refresh every pane that may show an affected directory after a drop.
   *  Defaults to refreshing only the owning pane. */
  refreshPanes?: () => void;
}

const THRESHOLD_PX = 5;

/**
 * A drop that would change nothing and should be ignored (no highlight, no
 * operation, no conflict dialog): the source already lives directly in the
 * target directory, or the target IS the dragged item itself / a descendant
 * of it (can't move a folder into itself).
 */
function isNoOpDropPath(targetDir: string, source: string): boolean {
  // samePath (not ===) because parentDir emits forward slashes while targetDir
  // comes from a DOM data-path (native backslashes on Windows).
  return samePath(parentDir(source), targetDir) || isInsideDir(targetDir, source);
}

export function usePointerDrag(deps: PointerDragDeps) {
  let dragActive = false;
  let nativeStarted = false;
  let dragPaths: string[] = [];
  let startX = 0;
  let startY = 0;
  let ghostEl: HTMLElement | null = null;
  let sourceEl: HTMLElement | null = null;
  let entryData: { path: string; name: string; kind: string; paths?: string[] } | null = null;

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

  function refreshPanes(): void {
    if (deps.refreshPanes) deps.refreshPanes();
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
      ghostEl = createDragGhost(sourceEl, fallback, dragPaths.length);
    }

    const zoom = getZoomFactor();
    ghostEl!.style.left = `${event.clientX / zoom}px`;
    ghostEl!.style.top = `${event.clientY / zoom}px`;
    ghostEl!.style.transform = "translate(-50%, -50%)";
    // Exit window → hand off to a native OS drag for cross-window / external
    // drops (the in-app pointer-drag is single-window: mouse events don't reach
    // another window). With implicit mouse capture, clientX/Y extends beyond
    // viewport bounds so we can detect the exit. This is fine alongside the
    // pointer-drag because no HTML5/OLE drag is running until this point — it
    // only starts once the cursor has actually left the window.
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
      const target = resolveDropTargetAtPoint(event.clientX, event.clientY);
      const destDir =
        target?.type === "folder" || target?.type === "tab"
          ? target.path
          : target?.type === "background"
            ? target.path || deps.getExplorer().currentPath
            : undefined;
      // Don't highlight a destination where the drop would be a no-op (every
      // dragged item is already there, or it's the dragged folder / a descendant).
      if (destDir !== undefined && dragPaths.every((p) => isNoOpDropPath(destDir, p))) {
        clearHighlights();
        return;
      }
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
    } else if (target?.type === "folder" || target?.type === "tab") {
      const paths = [...dragPaths];
      const targetPath = target.path;
      cleanup(true);
      // Skip no-op drops (already in this folder, or onto self/descendant) so
      // they don't trigger a spurious "already exists" conflict dialog. A
      // multi-item drop is one undoable batch (#163).
      const valid = paths.filter((sourcePath) => !isNoOpDropPath(targetPath, sourcePath));
      await handleFileDropMany(valid, targetPath, isCopy, { onRefresh: refreshPanes });
      return;
    } else if (target?.type === "background") {
      const destPath = target.path || explorer.currentPath;
      const sourceDir = dragPaths[0] ? parentDir(dragPaths[0]) : undefined;
      if (sourceDir !== undefined && !samePath(sourceDir, destPath)) {
        const paths = [...dragPaths];
        cleanup(true);
        // No existingNames: performFileTransfer must fetch the target dir
        // for its conflict check (an empty Set would be treated as
        // authoritative and bypass the conflict dialog entirely). Background
        // drops are move-only; a multi-item drop is one undoable batch (#163).
        const movable = paths.filter((sourcePath) => !samePath(parentDir(sourcePath), destPath));
        await handleFileDropMany(movable, destPath, false, { onRefresh: refreshPanes });
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

export function createDragGhost(
  sourceEl?: HTMLElement | null,
  fallbackText?: string,
  itemCount = 1,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "pointer-drag-ghost";

  const icon = sourceEl?.querySelector<HTMLElement>("[data-drag-icon]") ?? null;
  const name = sourceEl?.querySelector<HTMLElement>("[data-drag-name]") ?? null;

  if (itemCount > 1 && icon) {
    // Multi-drag (#258): a fanned stack of the icon with a count badge, so
    // the ghost reads as "all N items", not just the row under the cursor.
    const stack = document.createElement("div");
    stack.style.cssText = "position: relative; width: 44px; height: 40px;";
    const layers = Math.min(3, itemCount);
    for (let i = layers - 1; i >= 0; i--) {
      const layer = icon.cloneNode(true) as HTMLElement;
      layer.style.cssText += `
        position: absolute;
        left: ${8 + i * 5}px;
        top: ${8 - i * 4}px;
        transform: rotate(${(i - 1) * 6}deg);
        opacity: ${1 - i * 0.25};
      `;
      stack.appendChild(layer);
    }
    const badge = document.createElement("span");
    badge.textContent = String(itemCount);
    badge.style.cssText = `
      position: absolute;
      right: -6px;
      bottom: -4px;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      border-radius: 9px;
      background: var(--accent, #0078d4);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      line-height: 18px;
      text-align: center;
      box-sizing: border-box;
    `;
    stack.appendChild(badge);
    el.appendChild(stack);
    const label = document.createElement("span");
    label.textContent = fallbackText || `${itemCount} items`;
    el.appendChild(label);
  } else if (icon || name) {
    if (icon) el.appendChild(icon.cloneNode(true));
    if (name) el.appendChild(name.cloneNode(true));
  } else {
    el.textContent = fallbackText || "";
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
    overflow: visible;
    text-overflow: ellipsis;
  `;
  document.body.appendChild(el);
  return el;
}
