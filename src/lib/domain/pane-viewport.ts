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

/** Fit preferences to descendant constraints without changing the saved tree.
 * Two linear passes; minima add along splits rather than expanding inversely
 * with ratios, so a deeply unbalanced tree cannot require exponential space. */
export function paneGeometry(root: PaneNode, viewport: PaneSize, divider = 6, inlineWidths: ReadonlyMap<string, number> = new Map()): PaneGeometry {
  const gap = nonnegative(divider);
  const minima = new Map<PaneNode, PaneSize>();
  function measure(node: PaneNode): PaneSize {
    if (node.type === "leaf") {
      const minimum = { ...MIN_PANE_SIZE, width: MIN_PANE_SIZE.width + nonnegative(inlineWidths.get(node.id) ?? 0) };
      minima.set(node, minimum);
      return minimum;
    }
    const a = measure(node.first), b = measure(node.second);
    const size = node.direction === "row"
      ? { width: a.width + gap + b.width, height: Math.max(a.height, b.height) }
      : { width: Math.max(a.width, b.width), height: a.height + gap + b.height };
    minima.set(node, size);
    return size;
  }
  const minimum = measure(root);
  const width = Math.max(nonnegative(viewport.width), minimum.width);
  const height = Math.max(nonnegative(viewport.height), minimum.height);
  const panes = new Map<string, LeafRect>();
  const splits = new Map<string, SplitGeometry>();
  function place(node: PaneNode, rect: LeafRect): void {
    if (node.type === "leaf") { panes.set(node.id, rect); return; }
    const a = minima.get(node.first) ?? MIN_PANE_SIZE;
    const b = minima.get(node.second) ?? MIN_PANE_SIZE;
    const horizontal = node.direction === "row";
    const extent = (horizontal ? rect.w : rect.h) - gap;
    const min = (horizontal ? a.width : a.height) / extent;
    const max = 1 - (horizontal ? b.width : b.height) / extent;
    const ratio = clamp(Number.isFinite(node.ratio) ? node.ratio : 0.5, min, max);
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
