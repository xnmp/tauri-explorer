/**
 * HTML preview magnification (#1352).
 *
 * The preview iframe is sandboxed without scripts or same-origin access, so the
 * document's intrinsic width cannot be measured. The frame instead lays out a
 * desktop page of HTML_FIT_LAYOUT_WIDTH CSS pixels and zoom only scales its
 * paint, like an image: "Fit" shows that page in full (never magnifying),
 * zooming in magnifies it and the pane scrolls horizontally, and zooming out
 * past Fit widens the layout to fill the pane. Re-laying the page out at
 * `pane / scale` instead (browser page zoom) made responsive pages reflow at
 * every step, so zooming never revealed more of them (#1361). Height needs no
 * model: the frame is sized in CSS to exactly the pane's visible height and
 * scrolls vertically inside itself.
 */

export type HtmlZoom = "fit" | number;

export interface HtmlPreviewFrame {
  readonly scale: number;
  /** Layout width of the frame in document CSS pixels. */
  readonly width: number;
  /** Width the scaled frame occupies in the pane. */
  readonly paintedWidth: number;
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

/**
 * Frame layout width and paint scale: at least the desktop layout width (never
 * reflowed narrower by zooming in) and at least as wide as the pane.
 */
export function htmlPreviewFrame(zoom: HtmlZoom, paneWidth: number): HtmlPreviewFrame {
  const scale = htmlPreviewScale(zoom, paneWidth);
  const width = positive(paneWidth) ? Math.max(HTML_FIT_LAYOUT_WIDTH, paneWidth / scale) : 0;
  return { scale, width, paintedWidth: width * scale };
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

