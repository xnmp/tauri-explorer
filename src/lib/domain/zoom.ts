/**
 * CSS zoom utilities.
 * Issue: tauri-obxi
 *
 * Platform asymmetry with CSS zoom on the document root. The split is by webview
 * ENGINE, not OS — the dev server runs Chromium on Linux, so an OS-based check
 * would misclassify it.
 *
 * WebKitGTK (Tauri's Linux webview):
 *   - clientX/Y: raw viewport pixels (NOT zoom-adjusted)
 *   - getBoundingClientRect(): CSS pixels (pre-zoom layout values)
 *   - To get container-relative CSS coords: clientX / zoom - rect.left
 *
 * WKWebView (macOS) and Chromium / WebView2 (Windows, and the Chromium dev
 * browser):
 *   - clientX/Y: viewport pixels (same space as getBoundingClientRect)
 *   - getBoundingClientRect(): viewport pixels (post-zoom rendered values)
 *   - To get container-relative CSS coords: (clientX - rect.left) / zoom
 *
 * The Chromium/WebView2 behavior was verified empirically: under
 * `documentElement.style.zoom`, getBoundingClientRect scales with the zoom AND
 * clientX/elementFromPoint stay in that same scaled space — identical to
 * WKWebView. WebKitGTK is the lone exception. Treating Windows (WebView2) like
 * WebKitGTK is what made the marquee rubber-band drift from the cursor when
 * zoomed.
 */

import { isMac } from "./platform";

/**
 * Does this webview engine report mouse coords (clientX/Y) and
 * getBoundingClientRect() in the SAME post-zoom viewport space?
 *
 * True for WKWebView (macOS) and Chromium/WebView2 (Windows + Chromium dev
 * browser); false only for WebKitGTK. Exported as a pure function so the
 * engine classification can be unit-tested.
 */
export function detectViewportZoomCoords(userAgent: string, mac: boolean): boolean {
  return mac || /Chrome|Chromium/.test(userAgent);
}

/** Resolved once at load: whether clientX and getBoundingClientRect share a space. */
const usesViewportZoomCoords: boolean = detectViewportZoomCoords(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
  isMac,
);

/**
 * Is this a Chromium-family engine (WebView2 on Windows + the Chromium dev
 * browser)? Deliberately distinct from detectViewportZoomCoords, which also
 * groups in mac's WKWebView.
 *
 * Needed for position:fixed overlays (the context menu): under root CSS `zoom`,
 * only Chromium needs a SINGLE client→CSS division to land the overlay at the
 * cursor; WebKitGTK and WKWebView need a double division. The context-menu
 * offset was observed only on Windows, so the legacy double-division must be
 * preserved on every engine except Chromium. Pure for unit testing.
 */
export function detectChromiumEngine(userAgent: string): boolean {
  return /Chrome|Chromium/.test(userAgent);
}

/** Resolved once at load: Chromium-family engine (see detectChromiumEngine). */
export const isChromiumEngine: boolean = detectChromiumEngine(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);

/** Get the current CSS zoom factor (1.0 = 100%).
 *  Intentionally impure: reads the live zoom from the document root, which is
 *  the single source of truth set by the zoom commands. */
export function getZoomFactor(): number {
  const zoomStr = document.documentElement.style.zoom;
  return zoomStr ? parseFloat(zoomStr) / 100 : 1;
}

/**
 * Convert a mouse clientX/Y to a container-relative CSS coordinate.
 * Handles the engine difference in how CSS zoom affects event/rect coordinates.
 */
export function clientToCSSRelative(clientCoord: number, rectEdge: number): number {
  const zoom = getZoomFactor();
  if (zoom === 1) return clientCoord - rectEdge;
  if (usesViewportZoomCoords) {
    return (clientCoord - rectEdge) / zoom;
  }
  return clientCoord / zoom - rectEdge;
}

/**
 * Convert a getBoundingClientRect dimension (width/height) to CSS pixels.
 * On WKWebView/Chromium, getBoundingClientRect returns viewport (post-zoom)
 * values. On WebKitGTK it already returns CSS (pre-zoom) values.
 */
export function rectDimToCSS(value: number): number {
  if (!usesViewportZoomCoords) return value;
  return value / getZoomFactor();
}

/**
 * Convert a CSS-space value to the viewport space used by getBoundingClientRect.
 * On WKWebView/Chromium this multiplies by zoom. On WebKitGTK it's a no-op
 * (rect already CSS).
 */
export function cssToRect(value: number): number {
  if (!usesViewportZoomCoords) return value;
  return value * getZoomFactor();
}

/** Convert a mouse event's clientX/clientY to zoom-adjusted CSS coordinates. */
export function adjustForZoom(x: number, y: number): { x: number; y: number } {
  const zoom = getZoomFactor();
  return { x: x / zoom, y: y / zoom };
}

/**
 * Coordinate calculator for `position: fixed` overlays under root CSS `zoom`.
 *
 * A fixed overlay lives inside the zoomed document root, so a `left: L` value
 * renders at a screen offset of `L × zoom` on Chromium and `L × zoom²` on
 * WebKitGTK/WKWebView (the empirically-observed "double scale"). To pin an
 * overlay to a point on screen we therefore have to divide the target screen
 * coordinate back down. How many times we divide depends on *which space the
 * target coordinate is already in*:
 *
 *   - `fixedFromClient` — target comes from a mouse event (clientX/Y).
 *   - `fixedFromRect`   — target comes from getBoundingClientRect() (anchoring
 *                         an overlay to an element, e.g. a dropdown under a
 *                         button).
 *
 * The two differ only on WebKitGTK, where clientX/Y are raw viewport pixels but
 * getBoundingClientRect() returns pre-zoom CSS pixels — already one division
 * ahead. Both are pure so the per-engine arithmetic can be unit-tested.
 */
export function fixedFromClient(
  clientCoord: number,
  zoom: number,
  chromium: boolean,
): number {
  if (zoom === 1) return clientCoord;
  return chromium ? clientCoord / zoom : clientCoord / (zoom * zoom);
}

export function fixedFromRect(
  rectCoord: number,
  zoom: number,
  viewportCoords: boolean,
  chromium: boolean,
): number {
  if (zoom === 1) return rectCoord;
  // WKWebView (post-zoom rect, ×zoom² fixed) needs two divisions; Chromium
  // (post-zoom rect, ×zoom fixed) and WebKitGTK (CSS rect, ×zoom² fixed) both
  // net to one.
  const divisions = viewportCoords && !chromium ? 2 : 1;
  return rectCoord / zoom ** divisions;
}

/** Live wrapper of {@link fixedFromClient} using the current zoom/engine. */
export function clientToFixed(clientCoord: number): number {
  return fixedFromClient(clientCoord, getZoomFactor(), isChromiumEngine);
}

/** Live wrapper of {@link fixedFromRect} using the current zoom/engine. */
export function rectToFixed(rectCoord: number): number {
  return fixedFromRect(rectCoord, getZoomFactor(), usesViewportZoomCoords, isChromiumEngine);
}
