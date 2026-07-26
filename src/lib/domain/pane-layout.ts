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

/**
 * Which way focus travels between existing panes (#501). Same four sides as
 * `SplitPlacement` — `Cmd+Alt+<key>` creates a pane on a side, plain
 * `Alt+<key>` moves focus to the pane already there — but named separately so
 * the two intents stay readable at call sites.
 */
export type FocusDirection = SplitPlacement;

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
  if (root.type === "leaf" && root.id !== targetId) return root;
  if (root.type === "split" && !hasLeaf(root, targetId)) return root;
  return splitNode(root, targetId, placement, newLeafId, splitId);
}

/** Whether any node (leaf or split) with `id` exists in the tree. */
export function hasNode(root: PaneNode, id: string): boolean {
  if (root.id === id) return true;
  if (root.type === "leaf") return false;
  return hasNode(root.first, id) || hasNode(root.second, id);
}

/**
 * Wrap the node `targetId` (a leaf OR a whole split subtree) in a new
 * split, placing a new leaf `newLeafId` on the given side of it. Returns
 * the new root, or the unchanged root if the target doesn't exist.
 * `splitId` names the created split node (for later ratio updates).
 */
export function splitNode(
  root: PaneNode,
  targetId: string,
  placement: SplitPlacement,
  newLeafId: string,
  splitId: string,
): PaneNode {
  if (root.id === targetId) {
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
  if (root.type === "leaf") return root;
  return {
    ...root,
    first: splitNode(root.first, targetId, placement, newLeafId, splitId),
    second: splitNode(root.second, targetId, placement, newLeafId, splitId),
  };
}

/**
 * Where a leaf sits relative to its sibling — everything needed to undo
 * its removal (#229): re-split the sibling node with the same placement
 * and ratio. Null when the leaf is the root (no sibling) or absent.
 */
export interface LeafSiblingContext {
  /** The node (leaf or whole subtree) the leaf was split against. */
  siblingId: string;
  /** Side of the sibling the leaf occupied. */
  placement: SplitPlacement;
  /** The parent split's ratio (first child's share). */
  ratio: number;
}

export function leafSiblingContext(root: PaneNode, id: string): LeafSiblingContext | null {
  if (root.type === "leaf") return null;
  const leafIsFirst = root.first.type === "leaf" && root.first.id === id;
  const leafIsSecond = root.second.type === "leaf" && root.second.id === id;
  if (leafIsFirst || leafIsSecond) {
    const sibling = leafIsFirst ? root.second : root.first;
    const placement: SplitPlacement =
      root.direction === "row"
        ? leafIsFirst
          ? "left"
          : "right"
        : leafIsFirst
          ? "up"
          : "down";
    return { siblingId: sibling.id, placement, ratio: root.ratio };
  }
  return leafSiblingContext(root.first, id) ?? leafSiblingContext(root.second, id);
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
 * The pane adjacent to `fromId` in a direction, or null when there is none
 * (#501) — the layout edge, an unknown pane, or a single-pane tab.
 *
 * Geometric rather than tree-structural: panes are compared by their rendered
 * rectangles, so focus lands on what the user actually sees in that direction
 * however the split tree happens to nest. A candidate must lie beyond the
 * source's edge on the movement axis AND overlap it on the perpendicular axis,
 * so a pane sitting diagonally across a corner is never picked.
 */
export function leafInDirection(
  root: PaneNode,
  fromId: string,
  direction: FocusDirection,
): string | null {
  const rects = leafRects(root);
  const from = rects.get(fromId);
  if (!from) return null;

  const horizontal = direction === "left" || direction === "right";
  let best: { id: string; gap: number; overlap: number } | null = null;

  // Map iteration follows leafRects' walk order, i.e. visual order, so equal
  // candidates resolve to the earlier pane deterministically.
  for (const [id, rect] of rects) {
    if (id === fromId) continue;
    const gap = gapTowards(from, rect, direction);
    if (gap < -ADJACENCY_EPSILON) continue;
    const overlap = horizontal
      ? overlapLength(from.y, from.h, rect.y, rect.h)
      : overlapLength(from.x, from.w, rect.x, rect.w);
    if (overlap <= ADJACENCY_EPSILON) continue;
    if (best === null || gap < best.gap - ADJACENCY_EPSILON) {
      best = { id, gap, overlap };
    } else if (gap <= best.gap + ADJACENCY_EPSILON && overlap > best.overlap) {
      best = { id, gap, overlap };
    }
  }
  return best?.id ?? null;
}

/** Fractions of a unit square compare cleanly well above float noise. */
const ADJACENCY_EPSILON = 1e-9;

/**
 * Distance from `from`'s edge on the movement axis to the near edge of
 * `other`. Negative when `other` is not beyond that edge at all.
 */
function gapTowards(from: LeafRect, other: LeafRect, direction: FocusDirection): number {
  switch (direction) {
    case "left":
      return from.x - (other.x + other.w);
    case "right":
      return other.x - (from.x + from.w);
    case "up":
      return from.y - (other.y + other.h);
    case "down":
      return other.y - (from.y + from.h);
  }
}

/** Length of the 1-D overlap between two spans. */
function overlapLength(aStart: number, aLength: number, bStart: number, bLength: number): number {
  return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart);
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
