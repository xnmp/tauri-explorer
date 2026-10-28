/**
 * Placement for a small `position: fixed` popup anchored above a control, such
 * as the video volume slider (#1425). Fixed positioning lets the popup escape
 * clipping by the scrollable player, but its offsets scale differently under
 * root CSS zoom, nested zoom (fullscreen previews undo the app zoom) and each
 * engine (see `zoom.ts`). Rather than model every case, the caller measures how
 * the popup's rect responds to a known offset and solves for the offset that
 * lands it on the target; everything here is rect-space arithmetic.
 */
export interface RectBox { readonly left: number; readonly top: number; readonly width: number; readonly height: number; }
export interface Point { readonly x: number; readonly y: number; }

/**
 * Rect-space top-left that centres `popup` horizontally over `anchor` with its
 * bottom edge on the anchor's top edge, kept `padding` inside the viewport.
 */
export function popupAbove(anchor: RectBox, popup: { width: number; height: number },
  viewport: { width: number; height: number }, padding = 4): Point {
  const clamp = (value: number, max: number) => Math.max(padding, Math.min(value, max - padding));
  return {
    x: clamp(anchor.left + anchor.width / 2 - popup.width / 2, viewport.width - popup.width),
    y: clamp(anchor.top - popup.height, viewport.height - popup.height),
  };
}

/** The CSS offset placing an edge at `target`, from its rect edge at offset 0 (`origin`) and at offset 100px (`probe`). */
export function measuredFixedOffset(target: number, origin: number, probe: number): number {
  const scale = (probe - origin) / 100;
  const offset = target - origin;
  return Number.isFinite(scale) && scale > 0 ? offset / scale : offset;
}
