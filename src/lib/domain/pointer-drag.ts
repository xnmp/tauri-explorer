/**
 * Press → threshold → active, shared by the pointer drags (#1642): file rows
 * (`use-pointer-drag`), sidebar items, window tabs, and FileList's check that a
 * click released away from its press ended a drag rather than clicking.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A press becomes a drag once the pointer has travelled this far from it. */
const DRAG_THRESHOLD_PX = 5;

export const pastDragThreshold = (from: Point, to: Point): boolean =>
  Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD_PX;
