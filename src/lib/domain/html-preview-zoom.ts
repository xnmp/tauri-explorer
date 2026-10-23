/**
 * HTML preview magnification (#1352).
 *
 * The preview iframe is sandboxed without scripts or same-origin access, so the
 * document's intrinsic width cannot be measured. Zoom therefore follows browser
 * page-zoom semantics instead: the frame lays out at `pane / scale` CSS pixels
 * and is painted scaled by `scale`, so it always covers the pane and the
 * document scrolls inside it. "Fit" emulates a desktop viewport of
 * HTML_FIT_LAYOUT_WIDTH pixels in a narrower pane, and never magnifies.
 */

export type HtmlZoom = "fit" | number;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface HtmlPreviewFrame {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

/** Layout width "Fit" shows in full: a common desktop browser viewport. */
export const HTML_FIT_LAYOUT_WIDTH = 1280;

/** Browser-style page zoom stops. */
export const HTML_ZOOM_LEVELS: readonly number[] = Object.freeze([
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
]);

const MIN_SCALE = HTML_ZOOM_LEVELS[0];
const MAX_SCALE = HTML_ZOOM_LEVELS[HTML_ZOOM_LEVELS.length - 1];

/** Narrow docked panes need Fit below the smallest explicit stop. */
export const HTML_FIT_MIN_SCALE = 0.1;

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Painted scale for a zoom choice in a pane of the given width. */
export function htmlPreviewScale(zoom: HtmlZoom, paneWidth: number): number {
  if (zoom !== "fit") return positive(zoom) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoom)) : 1;
  if (!positive(paneWidth)) return 1;
  return Math.max(HTML_FIT_MIN_SCALE, Math.min(1, paneWidth / HTML_FIT_LAYOUT_WIDTH));
}

/** Frame layout size and paint scale that exactly cover the pane. */
export function htmlPreviewFrame(zoom: HtmlZoom, pane: Size): HtmlPreviewFrame {
  const scale = htmlPreviewScale(zoom, pane.width);
  const extent = (value: number) => (positive(value) ? value / scale : 0);
  return { scale, width: extent(pane.width), height: extent(pane.height) };
}

/** Next zoom stop strictly beyond the current painted scale, or null at the limit. */
export function stepHtmlZoom(zoom: HtmlZoom, paneWidth: number, direction: 1 | -1): number | null {
  const current = htmlPreviewScale(zoom, paneWidth);
  // Fit scales are usually between stops; tolerate rounding at a stop itself.
  const epsilon = 1e-6;
  const next = direction > 0
    ? HTML_ZOOM_LEVELS.find(level => level > current + epsilon)
    : [...HTML_ZOOM_LEVELS].reverse().find(level => level < current - epsilon);
  return next ?? null;
}

/** Whole-percent label for the painted scale. */
export function htmlZoomLabel(zoom: HtmlZoom, paneWidth: number): string {
  return `${Math.round(htmlPreviewScale(zoom, paneWidth) * 100)}%`;
}
