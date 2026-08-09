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
 *
 * Standardized CSS zoom (Interop 2024; Chromium ≥128, WebKitGTK ≥2.44,
 * Safari ≥17.4): clientX/Y AND getBoundingClientRect are both post-zoom
 * viewport px on EVERY engine, so the conversion is one subtraction and one
 * division, engine-independent — the same model fixedFromClient adopted in
 * #227. The old "WebKitGTK reports pre-zoom rects" branch survived here and
 * re-broke the marquee at zoom on the real Linux webview (#241).
 */
export function clientToCSSRelative(clientCoord: number, rectEdge: number): number {
  return (clientCoord - rectEdge) / getZoomFactor();
}

/**
 * Convert a getBoundingClientRect dimension (width/height) to CSS pixels.
 * Rects are post-zoom viewport px under standardized CSS zoom — one division
 * on every engine (#241).
 */
export function rectDimToCSS(value: number): number {
  return value / getZoomFactor();
}

/**
 * Convert a CSS-space value to the viewport space used by getBoundingClientRect.
 * The inverse of rectDimToCSS — one multiplication on every engine (#241).
 */
export function cssToRect(value: number): number {
  return value * getZoomFactor();
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
  return chromium ? clientCoord / zoom : clientCoord / zoom ** 2;
}

export function fixedFromRect(
  rectCoord: number,
  zoom: number,
  viewportCoords: boolean,
  chromium: boolean,
): number {
  if (zoom === 1) return rectCoord;
  // WKWebView reports a post-zoom rect and applies zoom twice to fixed
  // overlays. WebKitGTK's rect is already CSS-space, so its second scale is
  // already accounted for; Chromium only scales fixed overlays once.
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
