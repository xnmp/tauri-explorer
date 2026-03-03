/**
 * CSS zoom utilities.
 * Issue: tauri-obxi
 *
 * WebKitGTK (Linux Tauri) does not adjust mouse event coordinates
 * for CSS zoom on the document root. This module provides helpers
 * to convert between physical and logical (CSS) coordinates.
 */

/** Get the current CSS zoom factor (1.0 = 100%). */
export function getZoomFactor(): number {
  const zoomStr = document.documentElement.style.zoom;
  return zoomStr ? parseFloat(zoomStr) / 100 : 1;
}

/** Convert a mouse event's clientX/clientY to zoom-adjusted CSS coordinates. */
export function adjustForZoom(x: number, y: number): { x: number; y: number } {
  const zoom = getZoomFactor();
  return { x: x / zoom, y: y / zoom };
}
