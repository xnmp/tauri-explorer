/**
 * CSS zoom utilities.
 * Issue: tauri-obxi
 *
 * Platform asymmetry with CSS zoom on the document root:
 *
 * WebKitGTK (Linux):
 *   - clientX/Y: raw viewport pixels (NOT zoom-adjusted)
 *   - getBoundingClientRect(): CSS pixels (pre-zoom layout values)
 *   - To get container-relative CSS coords: clientX / zoom - rect.left
 *
 * WKWebView (macOS):
 *   - clientX/Y: viewport pixels (same space as getBoundingClientRect)
 *   - getBoundingClientRect(): viewport pixels (post-zoom rendered values)
 *   - To get container-relative CSS coords: (clientX - rect.left) / zoom
 */

import { isMac } from "./platform";

/** Get the current CSS zoom factor (1.0 = 100%).
 *  Intentionally impure: reads the live zoom from the document root, which is
 *  the single source of truth set by the zoom commands. */
export function getZoomFactor(): number {
  const zoomStr = document.documentElement.style.zoom;
  return zoomStr ? parseFloat(zoomStr) / 100 : 1;
}

/**
 * Convert a mouse clientX/Y to a container-relative CSS coordinate.
 * Handles the platform difference in how CSS zoom affects event/rect coordinates.
 */
export function clientToCSSRelative(clientCoord: number, rectEdge: number): number {
  const zoom = getZoomFactor();
  if (zoom === 1) return clientCoord - rectEdge;
  if (isMac) {
    return (clientCoord - rectEdge) / zoom;
  }
  return clientCoord / zoom - rectEdge;
}

/**
 * Convert a getBoundingClientRect dimension (width/height) to CSS pixels.
 * On macOS, getBoundingClientRect returns viewport (post-zoom) values.
 * On Linux, it already returns CSS (pre-zoom) values.
 */
export function rectDimToCSS(value: number): number {
  if (!isMac) return value;
  return value / getZoomFactor();
}

/**
 * Convert a CSS-space value to the viewport space used by getBoundingClientRect.
 * On macOS, this multiplies by zoom. On Linux, it's a no-op (rect already CSS).
 */
export function cssToRect(value: number): number {
  if (!isMac) return value;
  return value * getZoomFactor();
}

/** Convert a mouse event's clientX/clientY to zoom-adjusted CSS coordinates. */
export function adjustForZoom(x: number, y: number): { x: number; y: number } {
  const zoom = getZoomFactor();
  return { x: x / zoom, y: y / zoom };
}
