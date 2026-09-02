/**
 * Position-based drop target detection.
 *
 * Two coordinate spaces:
 * - onDragDropEvent (Tauri): physical pixels → divide by DPR and zoom
 * - PointerEvent.clientX/Y: CSS viewport pixels → divide by zoom only
 */

import { getZoomFactor } from "$lib/domain/zoom";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

export type DropTargetResult =
  | { type: "folder"; path: string }
  | { type: "tab"; tabId: string; path: string }
  | { type: "background"; path?: string }
  | { type: "sidebar" }
  | { type: "terminal" }
  | null;

let highlightedElement: HTMLElement | null = null;

// Tauri onDragDropEvent gives physical pixels. elementFromPoint in
// WebKitGTK expects viewport coordinates (DPR-adjusted, no zoom).
function adjustForHitTest(pos: { x: number; y: number }): { x: number; y: number } {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return { x: pos.x / dpr, y: pos.y / dpr };
}

export function adjustForPointerZoom(pos: { x: number; y: number }): { x: number; y: number } {
  const zoom = getZoomFactor();
  if (zoom === 1) return pos;
  return { x: pos.x / zoom, y: pos.y / zoom };
}

function resolveFromElement(el: Element | null): DropTargetResult {
  if (!el) return null;

  // Embedded terminal: dropping types the paths into the shell prompt (#265).
  const terminal = (el as HTMLElement).closest?.(".terminal-panel");
  if (terminal) return { type: "terminal" };

  const folderEntry = (el as HTMLElement).closest?.(".entry-item.directory[data-path]");
  if (folderEntry) {
    const path = folderEntry.getAttribute("data-path");
    if (path) return { type: "folder", path };
  }

  // Miller column directory entries
  const millerEntry = (el as HTMLElement).closest?.(".col-entry[data-path]");
  if (millerEntry) {
    const kind = millerEntry.getAttribute("data-kind");
    const path = millerEntry.getAttribute("data-path");
    if (kind === "directory" && path) return { type: "folder", path };
  }

  // Breadcrumb segment — drop into that ancestor directory.
  const crumb = (el as HTMLElement).closest?.(".crumb[data-path]");
  if (crumb) {
    const path = crumb.getAttribute("data-path");
    if (path) return { type: "folder", path };
  }

  // A specific bookmark is a folder destination. The surrounding Bookmarks
  // section remains a sidebar target so dropping a folder in its empty space
  // still pins it instead of moving it.
  const bookmark = (el as HTMLElement).closest?.(".bookmark-drop-target[data-path]");
  if (bookmark) {
    const path = bookmark.getAttribute("data-path");
    if (path) return { type: "folder", path };
  }

  const sidebar = (el as HTMLElement).closest?.(".quick-access");
  if (sidebar) return { type: "sidebar" };

  // Tab bar — drop files into the tab's directory
  const tabEl = (el as HTMLElement).closest?.(".tab[data-tab-id]");
  if (tabEl) {
    const tabId = tabEl.getAttribute("data-tab-id");
    if (tabId) {
      const path = windowTabsManager.getTabPath(tabId);
      if (path) return { type: "tab", tabId, path };
    }
  }

  // Miller column background (empty space)
  const millerCol = (el as HTMLElement).closest?.(".miller-col[data-path]");
  if (millerCol) {
    const path = millerCol.getAttribute("data-path") || undefined;
    return { type: "background", path };
  }

  const fileList = (el as HTMLElement).closest?.(".content");
  if (fileList) {
    const path = fileList.getAttribute("data-current-path") || undefined;
    return { type: "background", path };
  }

  return null;
}

/** Resolve drop target from onDragDropEvent position (physical pixels). */
export function resolveDropTarget(position: { x: number; y: number }): DropTargetResult {
  const adjusted = adjustForHitTest(position);
  const el = document.elementFromPoint(adjusted.x, adjusted.y);
  return resolveFromElement(el);
}

/** Resolve drop target from pointer event coordinates (CSS viewport pixels). */
export function resolveDropTargetAtPoint(x: number, y: number): DropTargetResult {
  const el = document.elementFromPoint(x, y);
  return resolveFromElement(el);
}

/** Highlight target from onDragDropEvent position (physical pixels). */
export function highlightTarget(position: { x: number; y: number }): void {
  const adjusted = adjustForHitTest(position);
  highlightAtCoords(adjusted.x, adjusted.y);
}

/** Highlight target from pointer event coordinates (CSS viewport pixels). */
export function highlightTargetAtPoint(x: number, y: number): void {
  highlightAtCoords(x, y);
}

function highlightAtCoords(cx: number, cy: number): void {
  const el = document.elementFromPoint(cx, cy);
  if (!el) {
    clearHighlights();
    clearSidebarHighlight();
    return;
  }

  const folderEntry = (el as HTMLElement).closest?.(".entry-item.directory[data-path]") as HTMLElement | null;
  const millerEntry = (el as HTMLElement).closest?.(".col-entry[data-kind='directory'][data-path]") as HTMLElement | null;
  const millerCol = (el as HTMLElement).closest?.(".miller-col[data-path]") as HTMLElement | null;
  const tabEl = (el as HTMLElement).closest?.(".tab[data-tab-id]") as HTMLElement | null;
  const crumbEl = (el as HTMLElement).closest?.(".crumb[data-path]") as HTMLElement | null;
  const bookmarkEl = (el as HTMLElement).closest?.(".bookmark-drop-target[data-path]") as HTMLElement | null;
  const sidebarEl = (el as HTMLElement).closest?.(".quick-access") as HTMLElement | null;
  const terminalEl = (el as HTMLElement).closest?.(".terminal-panel") as HTMLElement | null;
  const targetEl = terminalEl || folderEntry || millerEntry || tabEl || crumbEl || bookmarkEl || millerCol || (!sidebarEl ? (el as HTMLElement).closest?.(".content") as HTMLElement | null : null);

  if (sidebarEl) {
    if (targetEl !== highlightedElement) {
      if (highlightedElement) highlightedElement.classList.remove("drop-target");
      highlightedElement = targetEl;
      if (highlightedElement) highlightedElement.classList.add("drop-target");
    }
    setSidebarHighlight(sidebarEl);
  } else {
    clearSidebarHighlight();
    if (targetEl !== highlightedElement) {
      if (highlightedElement) highlightedElement.classList.remove("drop-target");
      highlightedElement = targetEl;
      if (highlightedElement) highlightedElement.classList.add("drop-target");
    }
  }
}

let highlightedSidebar: HTMLElement | null = null;

function setSidebarHighlight(el: HTMLElement): void {
  if (el === highlightedSidebar) return;
  clearSidebarHighlight();
  highlightedSidebar = el;
  el.classList.add("drag-over");
}

function clearSidebarHighlight(): void {
  if (highlightedSidebar) {
    highlightedSidebar.classList.remove("drag-over");
    highlightedSidebar = null;
  }
}

export function clearHighlights(): void {
  if (highlightedElement) {
    highlightedElement.classList.remove("drop-target");
    highlightedElement = null;
  }
  clearSidebarHighlight();
}
