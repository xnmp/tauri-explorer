/**
 * Position-based drop target detection.
 *
 * Two coordinate spaces:
 * - onDragDropEvent (Tauri): physical pixels → divide by DPR and zoom
 * - PointerEvent.clientX/Y: CSS viewport pixels → divide by zoom only
 */

import { settingsStore } from "$lib/state/settings.svelte";

export type DropTargetResult =
  | { type: "folder"; path: string }
  | { type: "background"; path?: string }
  | { type: "sidebar" }
  | null;

let highlightedElement: HTMLElement | null = null;

function adjustForZoom(pos: { x: number; y: number }): { x: number; y: number } {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const zoom = settingsStore.zoomLevel / 100;
  return { x: pos.x / dpr / zoom, y: pos.y / dpr / zoom };
}

export function adjustForPointerZoom(pos: { x: number; y: number }): { x: number; y: number } {
  const zoom = settingsStore.zoomLevel / 100;
  return { x: pos.x / zoom, y: pos.y / zoom };
}

function resolveFromElement(el: Element | null): DropTargetResult {
  if (!el) return null;

  const folderEntry = (el as HTMLElement).closest?.(".entry-item.directory[data-path]");
  if (folderEntry) {
    const path = folderEntry.getAttribute("data-path");
    if (path) return { type: "folder", path };
  }

  const sidebar = (el as HTMLElement).closest?.(".quick-access");
  if (sidebar) return { type: "sidebar" };

  const fileList = (el as HTMLElement).closest?.(".content");
  if (fileList) {
    const path = fileList.getAttribute("data-current-path") || undefined;
    return { type: "background", path };
  }

  return null;
}

/** Resolve drop target from onDragDropEvent position (physical pixels). */
export function resolveDropTarget(position: { x: number; y: number }): DropTargetResult {
  const adjusted = adjustForZoom(position);
  const el = document.elementFromPoint(adjusted.x, adjusted.y);
  return resolveFromElement(el);
}

/** Resolve drop target from pointer event coordinates (CSS viewport pixels). */
export function resolveDropTargetAtPoint(x: number, y: number): DropTargetResult {
  const adjusted = adjustForPointerZoom({ x, y });
  const el = document.elementFromPoint(adjusted.x, adjusted.y);
  return resolveFromElement(el);
}

/** Highlight target from onDragDropEvent position (physical pixels). */
export function highlightTarget(position: { x: number; y: number }): void {
  const adjusted = adjustForZoom(position);
  highlightAtCoords(adjusted.x, adjusted.y);
}

/** Highlight target from pointer event coordinates (CSS viewport pixels). */
export function highlightTargetAtPoint(x: number, y: number): void {
  const adjusted = adjustForPointerZoom({ x, y });
  highlightAtCoords(adjusted.x, adjusted.y);
}

function highlightAtCoords(cx: number, cy: number): void {
  const el = document.elementFromPoint(cx, cy);
  if (!el) {
    clearHighlights();
    return;
  }

  const folderEntry = (el as HTMLElement).closest?.(".entry-item.directory[data-path]") as HTMLElement | null;
  const targetEl = folderEntry || (el as HTMLElement).closest?.(".content") as HTMLElement | null;

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
