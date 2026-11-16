import type { LeafRect } from './pane-layout';

export type PaneInsets = readonly [top: number, right: number, bottom: number, left: number];
export const NO_PANE_INSET: PaneInsets = [0, 0, 0, 0];

/** Pane creation reveal timing, shared by its file-view entry reflow. */
export const PANE_CREATION_MS = 220;
export const PANE_CREATION_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)';

/** CSS custom property a held pane frame carries for the reveal's lifetime:
 * how much wider than its final bounds the frame is held (#1718). The file
 * view lays out at the final width immediately and paints its moving entries
 * into this extra width. FileList.svelte reads the same literal name in CSS. */
export const PANE_CONTENT_HOLD_X = '--pane-content-hold-x';

/** The actual visible/hit-testable area of a clipped pane in canvas pixels. */
export function visiblePaneRect(rect: LeafRect, [top, right, bottom, left]: PaneInsets): LeafRect {
  return { x: rect.x + left, y: rect.y + top, w: Math.max(0, rect.w - left - right), h: Math.max(0, rect.h - top - bottom) };
}

/** Keep the frame's size fixed for the whole reveal. Only position and clipping
 * interpolate; releasing the effect settles the frame at its target size once,
 * rather than rebuilding a large virtualized grid on every frame. The file
 * view inside still reflows to the target width on the first frame, using
 * `held` as paint-only room for entries moving to their new places (#1718). */
export function stablePaneFrame(from: LeafRect, clip: PaneInsets, to: LeafRect) {
  const w = Math.max(from.w, to.w), h = Math.max(from.h, to.h);
  return {
    from: { ...from, w, h },
    to: { ...to, w, h },
    fromClip: [clip[0], clip[1] + w - from.w, clip[2] + h - from.h, clip[3]] as PaneInsets,
    toClip: [0, w - to.w, h - to.h, 0] as PaneInsets,
    /** Extent held beyond the final bounds: paint-only room, not layout. */
    held: { w: w - to.w, h: h - to.h },
  };
}
