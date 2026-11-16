import type { LeafRect } from './pane-layout';

export type PaneInsets = readonly [top: number, right: number, bottom: number, left: number];
export const NO_PANE_INSET: PaneInsets = [0, 0, 0, 0];

/** The actual visible/hit-testable area of a clipped pane in canvas pixels. */
export function visiblePaneRect(rect: LeafRect, [top, right, bottom, left]: PaneInsets): LeafRect {
  return { x: rect.x + left, y: rect.y + top, w: Math.max(0, rect.w - left - right), h: Math.max(0, rect.h - top - bottom) };
}

/** Keep content layout fixed for the whole reveal. Only position and clipping
 * interpolate; releasing the effect settles the live view at its target size
 * once, rather than rebuilding a large virtualized grid on every frame. */
export function stablePaneFrame(from: LeafRect, clip: PaneInsets, to: LeafRect) {
  const w = Math.max(from.w, to.w), h = Math.max(from.h, to.h);
  return {
    from: { ...from, w, h },
    to: { ...to, w, h },
    fromClip: [clip[0], clip[1] + w - from.w, clip[2] + h - from.h, clip[3]] as PaneInsets,
    toClip: [0, w - to.w, h - to.h, 0] as PaneInsets,
  };
}
