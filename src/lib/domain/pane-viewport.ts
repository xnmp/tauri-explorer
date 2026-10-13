import type { LeafRect, PaneNode } from "./pane-layout";

export interface PaneSize { width: number; height: number }
export const MIN_PANE_SIZE: Readonly<PaneSize> = { width: 240, height: 200 };
export interface SplitGeometry { rect: LeafRect; ratio: number; min: number; max: number }
export interface PaneGeometry extends PaneSize {
  /** Leaf rectangles in workspace CSS pixels, also used by directional focus. */
  panes: ReadonlyMap<string, LeafRect>;
  splits: ReadonlyMap<string, SplitGeometry>;
  divider: number;
}

const nonnegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Every node's subtree minimum, keyed by node id, bottom-up in one linear pass.
 * It needs no viewport measurement, so rendering enforces these minima in CSS
 * (canvas and split children) and follows a viewport change in the same layout
 * pass; measured geometry lands a frame later and would paint panes at the
 * previous viewport size (#1061). */
export function paneMinima(root: PaneNode, divider = 6, inlineWidths: ReadonlyMap<string, number> = new Map()): ReadonlyMap<string, PaneSize> {
  const gap = nonnegative(divider);
  const minima = new Map<string, PaneSize>();
  function measure(node: PaneNode): PaneSize {
    if (node.type === "leaf") {
      // A lone pane always fills the viewport height, so its address bar never
      // scrolls out of view in a short window; the minimum only guards splits.
      const height = root.type === "leaf" ? 0 : MIN_PANE_SIZE.height;
      const minimum = { width: MIN_PANE_SIZE.width + nonnegative(inlineWidths.get(node.id) ?? 0), height };
      minima.set(node.id, minimum);
      return minimum;
    }
    const a = measure(node.first), b = measure(node.second);
    const size = node.direction === "row"
      ? { width: a.width + gap + b.width, height: Math.max(a.height, b.height) }
      : { width: Math.max(a.width, b.width), height: a.height + gap + b.height };
    minima.set(node.id, size);
    return size;
  }
  measure(root);
  return minima;
}

/** The saved preference a split renders before descendant minima constrain it. */
export function preferredSplitRatio(ratio: number): number {
  return Number.isFinite(ratio) ? clamp(ratio, 0, 1) : 0.5;
}

/** Fit preferences to descendant constraints without changing the saved tree.
 * Two linear passes; minima add along splits rather than expanding inversely
 * with ratios, so a deeply unbalanced tree cannot require exponential space.
 * The canvas is max(viewport, root minimum) and each split clamps its preference
 * so both children keep their minima: exactly what CSS flex resolution gives
 * for grow factors ratio : 1 - ratio over min-sized children. */
export function paneGeometry(root: PaneNode, viewport: PaneSize, divider = 6, inlineWidths: ReadonlyMap<string, number> = new Map()): PaneGeometry {
  const gap = nonnegative(divider);
  const minima = paneMinima(root, gap, inlineWidths);
  const minimum = minima.get(root.id)!;
  const width = Math.max(nonnegative(viewport.width), minimum.width);
  const height = Math.max(nonnegative(viewport.height), minimum.height);
  const panes = new Map<string, LeafRect>();
  const splits = new Map<string, SplitGeometry>();
  function place(node: PaneNode, rect: LeafRect): void {
    if (node.type === "leaf") { panes.set(node.id, rect); return; }
    const a = minima.get(node.first.id) ?? MIN_PANE_SIZE;
    const b = minima.get(node.second.id) ?? MIN_PANE_SIZE;
    const horizontal = node.direction === "row";
    const extent = (horizontal ? rect.w : rect.h) - gap;
    const min = (horizontal ? a.width : a.height) / extent;
    const max = 1 - (horizontal ? b.width : b.height) / extent;
    const ratio = clamp(preferredSplitRatio(node.ratio), min, max);
    splits.set(node.id, { rect, ratio, min: clamp(0.1, min, max), max: clamp(0.9, min, max) });
    const first = extent * ratio;
    if (horizontal) {
      place(node.first, { ...rect, w: first });
      place(node.second, { ...rect, x: rect.x + first + gap, w: extent - first });
    } else {
      place(node.first, { ...rect, h: first });
      place(node.second, { ...rect, y: rect.y + first + gap, h: extent - first });
    }
  }
  place(root, { x: 0, y: 0, w: width, h: height });
  return { width, height, panes, splits, divider: gap };
}

/** Nearest-edge reveal in the workspace only. When inline panels make a pane
 * wider than the viewport, reveal its main content rather than the accessories.
 * Content that is itself oversized retains its leading edge. */
export function revealPane(scroll: { left: number; top: number }, viewport: PaneSize, pane: LeafRect, leadingInlineWidth = 0) {
  function axis(offset: number, extent: number, start: number, size: number) {
    if (start < offset || size > extent) return start;
    return start + size > offset + extent ? start + size - extent : offset;
  }
  const inset = pane.w > viewport.width
    ? Math.min(nonnegative(leadingInlineWidth), Math.max(0, pane.w - MIN_PANE_SIZE.width))
    : 0;
  return {
    left: axis(scroll.left, viewport.width, pane.x + inset, pane.w - inset),
    top: axis(scroll.top, viewport.height, pane.y, pane.h),
  };
}


/** Keyboard movement begins at the rendered value, even when a saved ratio
 * cannot currently fit. Modifiers/DOM event ownership belong to the adapter. */
export function splitRatioFromKey(direction: "row" | "column", key: string, geometry: SplitGeometry): number | undefined {
  const backward = direction === "row" ? "ArrowLeft" : "ArrowUp";
  const forward = direction === "row" ? "ArrowRight" : "ArrowDown";
  const value = key === "Home" ? geometry.min : key === "End" ? geometry.max
    : key === backward ? geometry.ratio - 0.05 : key === forward ? geometry.ratio + 0.05 : undefined;
  return value === undefined ? undefined : clamp(value, geometry.min, geometry.max);
}
