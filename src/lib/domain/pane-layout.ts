/**
 * Pane layout tree — pure domain logic (#228).
 *
 * A tab's pane arrangement is a binary split tree: leaves are panes,
 * internal nodes are splits (row = side by side, column = stacked) with a
 * ratio giving the first child's share. All operations are immutable and
 * framework-free; the window-tabs manager owns the live state.
 */

export type SplitDirection = "row" | "column";

/** Where a new pane lands relative to the target pane (ghostty-style). */
export type SplitPlacement = "left" | "right" | "up" | "down";

export interface PaneLeaf {
  readonly type: "leaf";
  readonly id: string;
}

export interface PaneSplit {
  readonly type: "split";
  readonly id: string;
  readonly direction: SplitDirection;
  /** First child's fraction of the split, clamped to [0.1, 0.9]. */
  readonly ratio: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export function leaf(id: string): PaneLeaf {
  return { type: "leaf", id };
}

/** All leaf (pane) ids in visual order: first child before second. */
export function leafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...leafIds(node.first), ...leafIds(node.second)];
}

export function hasLeaf(node: PaneNode, id: string): boolean {
  return leafIds(node).includes(id);
}

export function countLeaves(node: PaneNode): number {
  return node.type === "leaf" ? 1 : countLeaves(node.first) + countLeaves(node.second);
}

function clampRatio(ratio: number): number {
  return Math.max(0.1, Math.min(0.9, ratio));
}

/**
 * Split the leaf `targetId`, placing a new leaf `newLeafId` on the given
 * side of it. Returns the new root, or the unchanged root if the target
 * leaf doesn't exist. `splitId` names the created split node (for later
 * ratio updates).
 */
export function splitLeaf(
  root: PaneNode,
  targetId: string,
  placement: SplitPlacement,
  newLeafId: string,
  splitId: string,
): PaneNode {
  if (root.type === "leaf") {
    if (root.id !== targetId) return root;
    const direction: SplitDirection = placement === "left" || placement === "right" ? "row" : "column";
    const newFirst = placement === "left" || placement === "up";
    return {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: newFirst ? leaf(newLeafId) : root,
      second: newFirst ? root : leaf(newLeafId),
    };
  }
  return {
    ...root,
    first: splitLeaf(root.first, targetId, placement, newLeafId, splitId),
    second: splitLeaf(root.second, targetId, placement, newLeafId, splitId),
  };
}

/**
 * Remove the leaf `id`; its sibling subtree takes the split's place.
 * Returns null when removing the only leaf (caller closes the tab).
 * Returns the unchanged root if the leaf doesn't exist.
 */
export function removeLeaf(root: PaneNode, id: string): PaneNode | null {
  if (root.type === "leaf") {
    return root.id === id ? null : root;
  }
  if (root.first.type === "leaf" && root.first.id === id) return root.second;
  if (root.second.type === "leaf" && root.second.id === id) return root.first;
  const first = removeLeaf(root.first, id);
  const second = removeLeaf(root.second, id);
  // Children are never the sole leaf here (leaf-child case handled above),
  // so a null can't propagate — but guard for type narrowing.
  return { ...root, first: first ?? root.first, second: second ?? root.second };
}

/** Set the ratio of the split node `splitId` (clamped). */
export function updateRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.type === "leaf") return root;
  if (root.id === splitId) return { ...root, ratio: clampRatio(ratio) };
  return {
    ...root,
    first: updateRatio(root.first, splitId, ratio),
    second: updateRatio(root.second, splitId, ratio),
  };
}

export interface LeafRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each leaf's rectangle as fractions of the tab area ([0,1] space). */
export function leafRects(node: PaneNode): Map<string, LeafRect> {
  const out = new Map<string, LeafRect>();
  function walk(n: PaneNode, rect: LeafRect): void {
    if (n.type === "leaf") {
      out.set(n.id, rect);
      return;
    }
    if (n.direction === "row") {
      walk(n.first, { ...rect, w: rect.w * n.ratio });
      walk(n.second, { ...rect, x: rect.x + rect.w * n.ratio, w: rect.w * (1 - n.ratio) });
    } else {
      walk(n.first, { ...rect, h: rect.h * n.ratio });
      walk(n.second, { ...rect, y: rect.y + rect.h * n.ratio, h: rect.h * (1 - n.ratio) });
    }
  }
  walk(node, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

/**
 * Dwindle placement (Hyprland-style): split the target pane along its
 * longer rendered axis, so repeated "new pane" calls spiral instead of
 * producing ever-thinner slices. `aspect` is the tab area's width/height
 * ratio (e.g. windowWidth / windowHeight); defaults to a typical landscape
 * window so pure-domain callers get sensible behavior.
 */
export function dwindlePlacement(root: PaneNode, targetId: string, aspect = 16 / 9): SplitPlacement {
  const rect = leafRects(root).get(targetId);
  if (!rect) return "right";
  return rect.w * aspect >= rect.h ? "right" : "down";
}
