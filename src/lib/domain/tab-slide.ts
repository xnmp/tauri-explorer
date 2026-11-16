/**
 * Tab enter/exit growth as a pure CSS-frame function (#1734).
 *
 * Svelte's `slide` measures the tab's width once, at insertion, and sets
 * `overflow: hidden`. Both broke the tab strip: the strip resizes a new tab
 * while it grows (#1708 compression), so the slide ended short and snapped,
 * and the hidden overflow clipped the active tab's fillets and outline, which
 * hang outside its box. WebKit also ignores an animated `width` on a flex item
 * whose width is set explicitly.
 *
 * Instead the tab's flex basis (and width, for WebKit) is a fraction of the
 * live `--tab-width` the strip publishes, so the growth follows the strip, and
 * the content is clipped by a `clip-path` widened by the fillet flare so the
 * fillets stay whole. `--tab-slide` exposes the progress to the stylesheet,
 * which grows the fillets and caps the corner radius with it.
 */

/** Slide durations, in milliseconds. */
export const TAB_SLIDE_IN_MS = 180;
export const TAB_SLIDE_OUT_MS = 120;

/** Vertical reach of the clip beyond the tab box: the 2px seam foot below and
 *  the outline above. Horizontal reach is the fillet flare. */
const CLIP_REACH = 4;

const unit = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1);
const fixed = (value: number): string => String(Math.round(value * 10000) / 10000);

/**
 * One frame of a tab sliding in (t: 0 → 1) or out (1 → 0).
 *
 * @param t      progress, clamped to 0..1 (non-finite counts as fully open)
 * @param width  the tab's final width as a CSS length, normally `var(--tab-width)`
 * @param flare  how far the fillets reach outside the tab box, in CSS px
 */
export function tabSlideCss(t: number, width = "var(--tab-width)", flare = 0): string {
  const p = fixed(unit(t));
  const reach = fixed(Math.max(0, Number.isFinite(flare) ? flare : 0));
  const size = `calc(${width} * ${p})`;
  return [
    `flex-basis: ${size}`,
    `width: ${size}`,
    "min-width: 0",
    `--tab-slide: ${p}`,
    `clip-path: inset(-${CLIP_REACH}px -${reach}px -${CLIP_REACH}px -${reach}px)`,
  ].join("; ") + ";";
}
