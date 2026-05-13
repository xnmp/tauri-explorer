/**
 * Position-based drop target detection.
 *
 * Two coordinate spaces:
 * - onDragDropEvent (Tauri): physical pixels → divide by DPR and zoom
 * - PointerEvent.clientX/Y: CSS viewport pixels → divide by zoom only
 */

import { getZoomFactor } from "$lib/domain/zoom";

export type DropTargetResult =
  | { type: "folder"; path: string }
  | { type: "background"; path?: string }
  | { type: "sidebar" }
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

  const sidebar = (el as HTMLElement).closest?.(".quick-access");
  if (sidebar) return { type: "sidebar" };

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
    return;
  }

  const folderEntry = (el as HTMLElement).closest?.(".entry-item.directory[data-path]") as HTMLElement | null;
  const millerEntry = (el as HTMLElement).closest?.(".col-entry[data-kind='directory'][data-path]") as HTMLElement | null;
  const millerCol = (el as HTMLElement).closest?.(".miller-col[data-path]") as HTMLElement | null;
  const targetEl = folderEntry || millerEntry || millerCol || (el as HTMLElement).closest?.(".content") as HTMLElement | null;

  if (targetEl !== highlightedElement) {
    if (highlightedElement) highlightedElement.classList.remove("drop-target");
    highlightedElement = targetEl;
    if (highlightedElement) highlightedElement.classList.add("drop-target");
  }
}

export function clearHighlights(): void {
  if (highlightedElement) {
    highlightedElement.classList.remove("drop-target");
    highlightedElement = null;
  }
}
