/**
 * Marquee rubber-band geometry expressed as compositor-only transforms (#1051).
 *
 * The band used to be one absolutely positioned element whose `width` and
 * `height` were rewritten on every pointer frame. Resizing a composited layer
 * reallocates and repaints its backing store, and on WebKitGTK that repaint
 * over a grid of image tiles took longer than the frame budget: a marquee in a
 * large picture folder visibly trailed the pointer even though the hit-testing
 * JavaScript cost ~1ms per frame.
 *
 * Instead, the band is drawn by five layers whose size is fixed for the whole
 * drag and whose only per-frame change is `transform`: a translucent fill the
 * size of the listing container, scaled down to the band, and four opaque
 * 1px edge lines each scaled along its length only. Translate + scale are
 * applied by the compositor with no layout and no paint, whatever the band
 * covers.
 *
 * The layers are container-sized rather than 1px on purpose: engines
 * rasterise a layer at an integer number of device pixels, so under a
 * fractional CSS zoom (130%) a 1px base rounds to one device pixel and the
 * scaled fill paints 1.3× too small while DOM measurements still report the
 * right box. With the base equal to the container's client box the scale
 * factor stays at or about 1 for any band the pointer can draw (the band is
 * clamped to the container's bounding rect, which can include a classic
 * scrollbar; a pane shrinking mid-drag can also push it slightly above), and
 * the rounding error stays below one device pixel.
 */

export interface MarqueeBand {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Intrinsic CSS size of the fill layer (the listing container the band is clamped to). */
export interface MarqueeLayerBase {
  width: number;
  height: number;
}

export interface MarqueeLayerTransforms {
  /** Translucent interior, scaled to the full band. */
  fill: string;
  top: string;
  bottom: string;
  left: string;
  right: string;
}

/** Thickness of each edge line in CSS pixels (the edge layers' intrinsic size). */
export const MARQUEE_EDGE_PX = 1;

function transform(x: number, y: number, scaleX: number, scaleY: number): string {
  return `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`;
}

function ratio(size: number, base: number): number {
  return base > 0 ? size / base : 0;
}

/**
 * CSS `transform` values for the fill and edge layers covering `band`, where
 * the fill layer and the horizontal edges are `base.width` wide and the fill
 * and the vertical edges are `base.height` tall.
 */
export function marqueeLayerTransforms(band: MarqueeBand, base: MarqueeLayerBase): MarqueeLayerTransforms {
  const { left, top, width, height } = band;
  // Edge lines are never shorter than their own thickness, so a band whose
  // pointer has not left the anchor still marks it instead of vanishing.
  const edgeWidth = Math.max(MARQUEE_EDGE_PX, width);
  const edgeHeight = Math.max(MARQUEE_EDGE_PX, height);
  return {
    fill: transform(left, top, ratio(width, base.width), ratio(height, base.height)),
    top: transform(left, top, ratio(edgeWidth, base.width), 1),
    bottom: transform(left, top + edgeHeight - MARQUEE_EDGE_PX, ratio(edgeWidth, base.width), 1),
    left: transform(left, top, 1, ratio(edgeHeight, base.height)),
    right: transform(left + edgeWidth - MARQUEE_EDGE_PX, top, 1, ratio(edgeHeight, base.height)),
  };
}
