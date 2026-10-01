/**
 * Commit-graph layout (#58, #179).
 * Pure functions — no framework or IPC deps.
 *
 * Behavioral reference: the VSCode Git Graph extension's vertex/branch model
 * (reimplemented from its documented behavior — its license does not permit
 * porting code). The key ideas:
 *
 * - A BRANCH is an uninterrupted first-parent chain, laid out top-to-bottom
 *   as one continuous polyline spanning many rows. Rendering one SVG path
 *   per branch is what keeps lines visually continuous.
 * - Colors belong to branches, not lanes. A color is reusable once the
 *   branch that held it has ended above the row where the next branch starts.
 * - Merge edges snap to a point already reserved for the same parent where
 *   possible instead of claiming fresh lanes, which keeps busy graphs tight.
 * - The checked-out commit's first-parent line reserves lane 0; all other
 *   lines claim the remaining lanes greedily left-to-right per row.
 * - Once a line occupies a lane it stays there while the lane is free, so
 *   lines run parallel and cross over in a single row at their destination
 *   instead of drifting left as lanes free up.
 */

import { compactRelativeTime } from "./relative-time";

export interface GraphCommitLike {
  oid: string;
  parents: readonly string[];
}

/** A point on the layout grid: `lane` = column, `row` = commit index. */
export interface GraphPoint {
  lane: number;
  row: number;
}

/** One continuous branch line: an ordered run of grid points. */
export interface BranchLine {
  colorIndex: number;
  points: GraphPoint[];
  /** Merge edge (non-first-parent): when its FIRST segment is stretched by an
   *  inline expansion, it crosses out of the child dot within the first
   *  row-height instead of hugging the destination — otherwise its long
   *  vertical runs down the CHILD's lane, painting over the trunk line that
   *  also occupies it (#390). */
  mergeEdge?: boolean;
}

/**
 * Restrict a branch line to the points needed to draw rows [startRow, endRow]
 * (#256, render windowing). Keeps the straddling segment endpoints — a long
 * straight lane encoded as two distant points must still cross the window —
 * and returns null when the line doesn't intersect the window at all.
 * Assumes `points` rows are non-decreasing (assignLayout emits top-down).
 */
export function sliceBranchLine(
  line: BranchLine,
  startRow: number,
  endRow: number,
): BranchLine | null {
  const pts = line.points;
  if (pts.length === 0) return null;
  if (pts[0].row > endRow || pts[pts.length - 1].row < startRow) return null;
  if (pts.length < 2) return line;

  // Last point at-or-above the window start…
  let first = 0;
  while (first + 1 < pts.length && pts[first + 1].row <= startRow) first++;
  // …through the first point at-or-below the window end.
  let last = pts.length - 1;
  while (last - 1 > first && pts[last - 1].row >= endRow) last--;

  if (first === 0 && last === pts.length - 1) return line;
  return { ...line, points: pts.slice(first, last + 1) };
}

export interface GraphVertex {
  /** Column of the commit dot. */
  lane: number;
  /** Color index of the branch the commit sits on. */
  colorIndex: number;
}

export interface GraphLayout {
  vertices: GraphVertex[];
  branches: BranchLine[];
  laneCount: number;
}

/** Observable trace result for one selected/hovered commit. `rows` identifies
 * the lineage's commit dots and list rows; `segments` is the exact graph
 * geometry connecting them, including the merge edge that absorbs the line.
 * Keeping both in the domain prevents renderers from guessing topology from
 * recycled lane colors. */
export interface GraphTrace {
  rows: ReadonlySet<number>;
  segments: readonly BranchLine[];
}

interface VertexState {
  parents: number[]; // indices into commits (-1 when parent not in page)
  nextParent: number; // next parent edge to route
  onBranch: number | null; // colorIndex of the branch this vertex sits on
  lane: number | null;
  nextFreeLane: number; // greedy per-row lane cursor
  /** lane → reservation key "parentRow:branchId" on this row. */
  reserved: Map<number, string>;
}

export function assignLayout(
  commits: readonly GraphCommitLike[],
  headOid: string | null = null,
): GraphLayout {
  const index = new Map<string, number>();
  commits.forEach((c, i) => index.set(c.oid, i));

  const vertices: VertexState[] = commits.map((c) => ({
    parents: c.parents.map((p) => index.get(p) ?? -1),
    nextParent: 0,
    onBranch: null,
    lane: null,
    nextFreeLane: 0,
    reserved: new Map(),
  }));

  // Reserve the leftmost lane before any greedy allocation happens. This is
  // deliberately based on the checked-out commit OID rather than its symbolic
  // branch name, so detached HEAD follows the same stable first-parent line.
  const headReservationKey = "head-line";
  const headLineRows = new Set<number>();
  let headRow = headOid === null ? undefined : index.get(headOid);
  while (headRow !== undefined && !headLineRows.has(headRow)) {
    headLineRows.add(headRow);
    const parentRow = vertices[headRow].parents[0];
    headRow = parentRow === undefined || parentRow === -1 ? undefined : parentRow;
  }
  if (headLineRows.size > 0) {
    for (const vertex of vertices) vertex.reserved.set(0, headReservationKey);
  }

  const branches: BranchLine[] = [];
  /** colorEnds[i] = row where the branch last using color slot i ended. */
  const colorEnds: number[] = [];
  let laneCount = 1;
  let branchIds = 0;

  function availableColor(startRow: number): number {
    for (let i = 0; i < colorEnds.length; i++) {
      if (startRow > colorEnds[i]) return i;
    }
    colorEnds.push(0);
    return colorEnds.length - 1;
  }

  /** Reserved-or-fresh lane on `row` for the given reservation key. Prefers
   *  the lane the line already occupies (`preferred`) when it is free, so
   *  lines stay parallel and only change lanes at their destination. */
  function claimPoint(row: number, key: string | null, preferred?: number): number {
    const v = vertices[row];
    if (key !== null) {
      for (const [lane, k] of v.reserved) {
        if (k === key) return lane;
      }
    }
    if (preferred !== undefined && !v.reserved.has(preferred)) return preferred;
    while (v.reserved.has(v.nextFreeLane)) v.nextFreeLane++;
    const lane = v.nextFreeLane;
    laneCount = Math.max(laneCount, lane + 1);
    return lane;
  }

  function reserve(row: number, lane: number, key: string): void {
    vertices[row].reserved.set(lane, key);
    laneCount = Math.max(laneCount, lane + 1);
  }

  /** Ensure the vertex at `row` has its dot placed on some lane. */
  function placeDot(row: number): number {
    const v = vertices[row];
    if (v.lane === null) {
      const onHeadLine = headLineRows.has(row);
      v.lane = claimPoint(row, onHeadLine ? headReservationKey : null);
      if (!onHeadLine) reserve(row, v.lane, `dot:${row}`);
    }
    return v.lane;
  }

  /** Route the next unprocessed parent edge of the vertex at `startRow`. */
  function determinePath(startRow: number): void {
    const start = vertices[startRow];
    const parentIdx = start.nextParent;
    const parentRow = start.parents[parentIdx] ?? -1;
    const isFirstParent = parentIdx === 0;
    let followsHeadLine = isFirstParent && headLineRows.has(startRow);
    start.nextParent++;

    const startLane = placeDot(startRow);

    // Parent outside the loaded page: nothing to draw yet.
    if (parentRow === -1) {
      if (start.onBranch === null) {
        start.onBranch = availableColor(startRow);
        colorEnds[start.onBranch] = startRow;
      }
      return;
    }

    const parent = vertices[parentRow];

    // Merge edge (or descent into an already-drawn branch): route down to the
    // parent's existing dot, snapping to points already reserved for it.
    if (!isFirstParent || parent.onBranch !== null) {
      const willJoin = parent.onBranch !== null;
      let colorIndex: number;
      if (isFirstParent) {
        // First-parent descent into an already-drawn branch: the edge is the
        // tail of the CHILD's branch, so it keeps the child's color down to
        // the join point — taking the parent's color painted the lower half
        // of a branch in another branch's color (#368). Tips that were never
        // colored (their only edge lands on an existing branch) get a fresh
        // color here rather than silently defaulting to color 0.
        colorIndex = start.onBranch ?? availableColor(startRow);
        start.onBranch = colorIndex;
        colorEnds[colorIndex] = Math.max(colorEnds[colorIndex] ?? 0, parentRow);
      } else {
        colorIndex = willJoin ? parent.onBranch! : availableColor(startRow);
      }
      const id = `edge:${branchIds++}:${parentRow}`;
      const line: BranchLine = {
        colorIndex,
        points: [{ lane: startLane, row: startRow }],
        ...(isFirstParent ? {} : { mergeEdge: true }),
      };
      let prevLane = startLane;
      for (let row = startRow + 1; row <= parentRow; row++) {
        let lane: number;
        if (row === parentRow) {
          lane = followsHeadLine ? claimPoint(row, headReservationKey) : placeDot(row);
        } else {
          lane = followsHeadLine
            ? claimPoint(row, headReservationKey)
            : claimPoint(row, id, prevLane);
          if (!followsHeadLine) reserve(row, lane, id);
        }
        line.points.push({ lane, row });
        prevLane = lane;
      }
      if (!willJoin) {
        parent.onBranch = colorIndex;
        colorEnds[colorIndex] = parentRow;
      }
      branches.push(line);
      return;
    }

    // Fresh descent: this vertex starts a first-parent chain (a branch).
    const colorIndex = start.onBranch ?? availableColor(startRow);
    start.onBranch = colorIndex;
    const id = `chain:${branchIds++}`;
    const line: BranchLine = { colorIndex, points: [{ lane: startLane, row: startRow }] };

    let targetRow = parentRow;
    let prevLane = startLane;
    for (let row = startRow + 1; row < commits.length; row++) {
      const v = vertices[row];
      const isTarget = row === targetRow;
      let lane: number;
      if (isTarget) {
        lane = followsHeadLine ? claimPoint(row, headReservationKey) : placeDot(row);
      } else {
        lane = followsHeadLine
          ? claimPoint(row, headReservationKey)
          : claimPoint(row, id, prevLane);
        if (!followsHeadLine) reserve(row, lane, id);
      }
      line.points.push({ lane, row });
      prevLane = lane;

      if (!isTarget) continue;
      // A synthetic working-tree row (or another first-parent child) can
      // reach HEAD before the layout driver reaches HEAD itself. From that
      // join onward, its continuation is the reserved HEAD line.
      if (headLineRows.has(row)) followsHeadLine = true;
      if (v.onBranch !== null) break; // joined an existing line — terminate

      // The parent joins this chain; continue through ITS first parent.
      v.onBranch = colorIndex;
      v.nextParent = Math.max(v.nextParent, 1);
      const next = v.parents[0] ?? -1;
      if (next === -1) break;
      targetRow = next;
    }

    colorEnds[colorIndex] = line.points[line.points.length - 1].row;
    branches.push(line);
  }

  // Drive: every vertex with an unrouted parent edge, or not yet on a branch.
  let i = 0;
  while (i < commits.length) {
    const v = vertices[i];
    if (v.nextParent < v.parents.length) {
      determinePath(i);
    } else if (v.onBranch === null) {
      // Parentless (root/orphan/out-of-page) commit: place and color it.
      placeDot(i);
      v.onBranch = availableColor(i);
      colorEnds[v.onBranch] = i;
    } else {
      i++;
    }
  }

  return {
    vertices: vertices.map((v) => ({
      lane: v.lane ?? 0,
      colorIndex: v.onBranch ?? 0,
    })),
    branches,
    laneCount,
  };
}

/**
 * Classify the first-parent lineage and its exact drawable geometry.
 *
 * Walking toward older commits follows `parents[0]`. Walking toward newer
 * commits follows the nearest first-parent child whose edge belongs to the
 * same drawn branch. A branch can curve between physical lanes, so comparing
 * vertex lane numbers alone would incorrectly stop at those bends. Lane color
 * is deliberately irrelevant: colors are recycled after a branch ends.
 */
export function traceGraphLineage(
  commits: readonly BranchLineCommitLike[],
  layout: GraphLayout,
  fromRow: number,
): GraphTrace {
  const empty = (): GraphTrace => ({ rows: new Set<number>(), segments: [] });
  if (
    !Array.isArray(commits) ||
    !layout ||
    !Array.isArray(layout.vertices) ||
    !Array.isArray(layout.branches) ||
    !Number.isInteger(fromRow) ||
    fromRow < 0 ||
    fromRow >= commits.length ||
    fromRow >= layout.vertices.length ||
    !commits[fromRow]?.oid
  ) {
    return empty();
  }

  const pointKey = (row: number, lane: number) => `${row}:${lane}`;
  const vertexKey = (row: number) => {
    const vertex = layout.vertices[row];
    return vertex && Number.isFinite(vertex.lane) ? pointKey(row, vertex.lane) : null;
  };

  // Index the already-computed layout once. Hover changes the selected row,
  // but a single classification must stay linear in the displayed geometry;
  // repeatedly scanning every branch for every ancestor caused deep-history
  // hover stalls.
  const ordinaryLinesByPoint = new Map<string, number[]>();
  const branchPointIndices = layout.branches.map((line, lineIndex) => {
    const indices = new Map<string, number>();
    if (!line || !Array.isArray(line.points)) return indices;
    line.points.forEach((point, pointIndex) => {
      if (!point || !Number.isFinite(point.row) || !Number.isFinite(point.lane)) return;
      const key = pointKey(point.row, point.lane);
      indices.set(key, pointIndex);
      if (!line.mergeEdge) {
        const memberships = ordinaryLinesByPoint.get(key) ?? [];
        memberships.push(lineIndex);
        ordinaryLinesByPoint.set(key, memberships);
      }
    });
    return indices;
  });
  const rowByOid = new Map<string, number>();
  const firstParentChildren = new Map<string, number[]>();
  commits.forEach((commit, row) => {
    if (!commit?.stash && commit?.oid) rowByOid.set(commit.oid, row);
    const parentOid = commit?.parents?.[0];
    if (commit?.oid && parentOid) {
      const children = firstParentChildren.get(parentOid) ?? [];
      children.push(row);
      firstParentChildren.set(parentOid, children);
    }
  });

  const sharesBranchEdge = (childRow: number, parentRow: number): boolean => {
    const childKey = vertexKey(childRow);
    const parentKey = vertexKey(parentRow);
    if (childKey === null || parentKey === null) return false;
    const parentLines = new Set(ordinaryLinesByPoint.get(parentKey) ?? []);
    return (ordinaryLinesByPoint.get(childKey) ?? []).some((lineIndex) => {
      if (!parentLines.has(lineIndex)) return false;
      const indices = branchPointIndices[lineIndex];
      return (indices.get(childKey) ?? -1) < (indices.get(parentKey) ?? -1);
    });
  };

  const rows = new Set<number>([fromRow]);

  // Older ancestry is exact: resolve each first parent strictly below the
  // current row so malformed/non-topological input cannot create a cycle.
  let currentRow = fromRow;
  while (true) {
    const parentOid = commits[currentRow]?.parents?.[0];
    if (!parentOid) break;
    const parentRow = rowByOid.get(parentOid) ?? -1;
    if (parentRow <= currentRow || rows.has(parentRow)) break;
    rows.add(parentRow);
    currentRow = parentRow;
  }

  // Newer ancestry is ambiguous when several children claim one first
  // parent. The drawn branch resolves that ambiguity without relying on color.
  currentRow = fromRow;
  while (true) {
    const current: BranchLineCommitLike | undefined = commits[currentRow];
    if (!current?.oid || !layout.vertices[currentRow]) break;
    let childRow = -1;
    const children: number[] = firstParentChildren.get(current.oid) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const row = children[i];
      if (
        row < currentRow &&
        !commits[row]?.stash &&
        sharesBranchEdge(row, currentRow)
      ) {
        childRow = row;
        break;
      }
    }
    if (childRow < 0 || rows.has(childRow)) break;
    rows.add(childRow);
    currentRow = childRow;
  }

  const firstParentEdges: Array<readonly [number, number]> = [];
  for (const childRow of rows) {
    const parentOid = commits[childRow]?.parents?.[0];
    if (!parentOid) continue;
    const parentRow = rowByOid.get(parentOid);
    if (parentRow !== undefined && parentRow > childRow && rows.has(parentRow)) {
      firstParentEdges.push([childRow, parentRow]);
    }
  }

  const intervalsByLine = new Map<number, Array<[number, number]>>();
  for (const [childRow, parentRow] of firstParentEdges) {
    const childKey = vertexKey(childRow);
    const parentKey = vertexKey(parentRow);
    if (childKey === null || parentKey === null) continue;
    const parentLines = new Set(ordinaryLinesByPoint.get(parentKey) ?? []);
    for (const lineIndex of ordinaryLinesByPoint.get(childKey) ?? []) {
      if (!parentLines.has(lineIndex)) continue;
      const indices = branchPointIndices[lineIndex];
      const start = indices.get(childKey);
      const end = indices.get(parentKey);
      if (start === undefined || end === undefined || start >= end) continue;
      const intervals = intervalsByLine.get(lineIndex) ?? [];
      intervals.push([start, end]);
      intervalsByLine.set(lineIndex, intervals);
    }
  }

  const segments: BranchLine[] = [];
  layout.branches.forEach((line, lineIndex) => {
    if (!line || !Array.isArray(line.points)) return;
    const lastRow = line.points.at(-1)?.row;
    // A non-first-parent merge into the traced lineage completes the visual
    // absorption arc even though its child commit belongs to another line.
    if (line.mergeEdge) {
      if (lastRow !== undefined && rows.has(lastRow)) {
        segments.push({ ...line, points: [...line.points] });
      }
      return;
    }

    const intervals = intervalsByLine.get(lineIndex) ?? [];
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1]) {
        previous[1] = Math.max(previous[1], interval[1]);
      } else {
        merged.push([...interval]);
      }
    }
    for (const [start, end] of merged) {
      segments.push({ ...line, points: line.points.slice(start, end + 1) });
    }
  });

  return { rows, segments };
}

/**
 * Direction of a jump along a branch line, stated in commit age rather than
 * screen direction so it stays true however the graph is ordered: `"older"`
 * follows the first-parent edge toward ancestors, `"newer"` walks back toward
 * the commit that claims this one as ITS first parent.
 */
export type BranchLineDirection = "older" | "newer";

/** Row shape the branch-line walk needs: the layout inputs plus the stash
 *  marker, because a woven stash entry is drawn on a line of its own. */
export interface BranchLineCommitLike extends GraphCommitLike {
  /** Set (e.g. `stash@{0}`) on rows woven in from the stash list. */
  stash?: string;
}

/**
 * Row of the neighbouring commit along `fromRow`'s FIRST-PARENT line (#530),
 * or -1 when there is none on the loaded page. Following that line is what
 * lets a jump skip the rows physically in between that belong to other lines,
 * which is the whole point of the shortcut.
 *
 * Not identical to "the polyline `assignLayout` drew", and deliberately so —
 * the layout assigns a commit to whichever chain REACHES it first walking rows
 * top-down, which is not recoverable from `{oid, parents}` alone:
 * - `"older"` is exact either way: `parents[0]` is always a drawn edge.
 * - `"newer"` is ambiguous when two commits share one first parent (two
 *   branches rooted at the same commit). The layout continues the topmost
 *   chain through the parent; this picks the NEAREST candidate above instead,
 *   i.e. the shortest jump. Both are defensible; nearest never skips over
 *   another commit that also sits on a first-parent edge into the target.
 *
 * Other deliberate edges:
 * - Only `parents[0]` is followed, so a merge commit steps onto its own line,
 *   never into the branch it merged in.
 * - A parent that is not on the loaded page (truncated history, filtered
 *   branches) is not a target — the jump stops rather than silently landing on
 *   an unrelated row.
 * - Stash rows are never a target: their `parents[0]` is the commit they were
 *   taken from, so they LOOK like on-line neighbours, but the layout draws
 *   each on its own lane and colour, and jumping onto one is a dead end that
 *   also hides the trunk row above it. Stepping OFF a stash still follows its
 *   edge down to its base commit.
 * - `"older"` only ever looks DOWN the list and `"newer"` only UP, so a
 *   non-topological ordering can never produce a backwards jump or a cycle.
 */
export function stepOnBranchLine(
  commits: readonly BranchLineCommitLike[],
  fromRow: number,
  direction: BranchLineDirection,
): number {
  if (!Number.isInteger(fromRow) || fromRow < 0 || fromRow >= commits.length) return -1;
  const from = commits[fromRow];
  if (!from?.oid) return -1;

  if (direction === "older") {
    const firstParent = from.parents?.[0];
    if (!firstParent) return -1;
    for (let row = fromRow + 1; row < commits.length; row++) {
      if (commits[row]?.stash) continue;
      if (commits[row]?.oid === firstParent) return row;
    }
    return -1;
  }

  for (let row = fromRow - 1; row >= 0; row--) {
    if (commits[row]?.stash) continue;
    if (commits[row]?.parents?.[0] === from.oid) return row;
  }
  return -1;
}

/**
 * Scroll offset that brings the row occupying `[rowTop, rowTop + rowHeight)`
 * fully into view, moving the minimum distance (#530) — a jump target can land
 * outside the virtualized render window entirely. A row already fully visible
 * leaves `scrollTop` untouched, so a jump never nudges the view for nothing.
 * An unmeasured viewport (height 0) is also left alone rather than scrolled to
 * a meaningless offset.
 */
export function scrollTopToReveal(
  rowTop: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  if (!(viewportHeight > 0)) return scrollTop;
  if (rowTop < scrollTop) return Math.max(0, rowTop);
  const rowBottom = rowTop + rowHeight;
  if (rowBottom > scrollTop + viewportHeight) return Math.max(0, rowBottom - viewportHeight);
  return scrollTop;
}

/**
 * SVG path for one branch line. Reference geometry: lane changes are cubic
 * beziers whose control points are PURE VERTICAL offsets (d = 0.8 × row
 * height) from each endpoint — vertical tangents at both ends, so stacked
 * curves join seamlessly. Consecutive collinear verticals merge into one
 * line command, keeping paths minimal and unbroken.
 */
/** Vertical inset applied to rows below an inline expansion (e.g. the
 *  commit-details block opened under a row) so the graph stretches with the
 *  shifted rows instead of drifting out of alignment. */
export interface RowExpand {
  /** Rows strictly after this index are pushed down. */
  afterRow: number;
  /** Extra pixels inserted below `afterRow`. */
  extra: number;
}

export function branchPath(
  line: BranchLine,
  laneWidth: number,
  rowHeight: number,
  expand?: RowExpand,
): string {
  if (line.points.length === 0) return "";
  const x = (lane: number) => lane * laneWidth + laneWidth / 2;
  const y = (row: number) =>
    row * rowHeight + rowHeight / 2 + (expand && row > expand.afterRow ? expand.extra : 0);
  const d = rowHeight * 0.8;

  let path = `M ${x(line.points[0].lane)} ${y(line.points[0].row).toFixed(1)}`;
  let i = 1;
  while (i < line.points.length) {
    const prev = line.points[i - 1];
    let j = i;
    // Merge a run of same-lane points into one vertical line command.
    while (j < line.points.length && line.points[j].lane === prev.lane) j++;
    if (j > i) {
      path += ` L ${x(prev.lane)} ${y(line.points[j - 1].row).toFixed(1)}`;
      i = j;
      continue;
    }
    const b = line.points[i];
    const x1 = x(prev.lane);
    const y1 = y(prev.row);
    const x2 = x(b.lane);
    const y2 = y(b.row);
    // A row expansion (open commit details) can stretch this segment far
    // beyond one row height. Stay vertical through the stretch and cross in
    // a single row-height — a full-stretch curve smears into a long diagonal
    // across the expanded block. WHICH end hugs matters (#390): a merge
    // edge's first segment leaves the child dot, whose lane the trunk also
    // occupies below it, so it must cross out IMMEDIATELY (first row-height)
    // and run the stretch in its own destination lane. Every other segment
    // hugs the destination (#221) — e.g. a first-parent edge's stretch runs
    // in the CHILD's exclusive lane and crosses into the shared parent dot
    // at the end.
    if (line.mergeEdge && i === 1 && y2 - rowHeight > y1 + 0.5) {
      const yCross = y1 + rowHeight;
      path += ` C ${x1} ${(y1 + d).toFixed(1)} ${x2} ${(yCross - d).toFixed(1)} ${x2} ${yCross.toFixed(1)}`;
      path += ` L ${x2} ${y2.toFixed(1)}`;
    } else {
      const yCross = y2 - rowHeight;
      if (yCross > y1 + 0.5) path += ` L ${x1} ${yCross.toFixed(1)}`;
      const yStart = Math.max(y1, yCross);
      path += ` C ${x1} ${(yStart + d).toFixed(1)} ${x2} ${(y2 - d).toFixed(1)} ${x2} ${y2.toFixed(1)}`;
    }
    i++;
  }
  return path;
}

/** Reference-default 12-color palette (configurable data, not code). */
export const GRAPH_PALETTE = [
  "#0085d9",
  "#d9008f",
  "#00d90a",
  "#d98500",
  "#a300d9",
  "#ff0000",
  "#00d9cc",
  "#e138e8",
  "#85d900",
  "#dc5b23",
  "#6f24d6",
  "#ffcc00",
] as const;

// ─── Ref decoration chips ────────────────────────────────────────────────────

/** Structural subset of a ref decoration; matches `RefInfo` from the API
 *  layer without importing it (domain stays dependency-free). */
export interface RefDecorationLike {
  kind: string;
  name: string;
}

/** A remote-only branch chip that no local branch tracks. Identity is kept
 *  (full name + split remote/branch) so the context menu can offer a tracking
 *  checkout — `git checkout -b <branch> --track <remote>/<branch>` (#432). */
export interface RemoteRefChip {
  /** Full shorthand, e.g. `origin/feat/x`. */
  name: string;
  /** Remote name (first path segment), e.g. `origin`. */
  remote: string;
  /** Branch name (remainder), e.g. `feat/x` — may itself contain slashes. */
  branch: string;
}

export interface RefChips {
  isHead: boolean;
  heads: { name: string; remotes: string[]; active: boolean }[];
  remotes: RemoteRefChip[];
  tags: string[];
}

/** Split a remote shorthand (`origin/feat/x`) into remote + branch at the
 *  first slash. A name with no slash keeps its whole value as both parts. */
export function splitRemoteRef(name: string): RemoteRefChip {
  const i = name.indexOf("/");
  return i > 0
    ? { name, remote: name.slice(0, i), branch: name.slice(i + 1) }
    : { name, remote: name, branch: name };
}

// ─── Bulk "hide remote-only branches" filter (#515) ──────────────────────────

/** Structural subset of the branch-filter popover's list entry: a branch
 *  shorthand plus which side of `git_refs` it came from. */
export interface BranchListEntry {
  /** Shorthand — `main` for locals, `origin/main` for remotes. */
  name: string;
  remote: boolean;
}

/** Remote-tracking branches with no local branch of the same shorthand
 *  (`origin/feat/x` with no local `feat/x`). Matching is by name, the same
 *  rule `groupRefChips` uses to nest remotes under their local branch. */
export function remoteOnlyBranchNames(branches: readonly BranchListEntry[]): string[] {
  const locals = new Set(branches.filter((b) => !b.remote).map((b) => b.name));
  return [
    ...new Set(
      branches
        .filter((b) => b.remote && !locals.has(splitRemoteRef(b.name).branch))
        .map((b) => b.name),
    ),
  ];
}

/** The seed spec for a `git_log` walk. */
export interface BranchQuery {
  /** Explicit tips to walk; `null` = HEAD + every branch (#342). */
  branches: string[] | null;
  /** Shorthands subtracted from whichever seed set is used; `null` = none. */
  excludeBranches: string[] | null;
}

/** Build the walk's seed spec from the per-branch/author selection (`null` =
 *  every branch) and the bulk "hide remote-only" toggle.
 *
 *  The toggle is deliberately expressed as a SUBTRACTION rather than folded
 *  into `branches`: spelling "every branch except these" as an explicit list
 *  would stop the backend seeding HEAD and would override `local_only`, so a
 *  hide toggle could make history appear (#515). An empty branch list — the
 *  popover loads it lazily — subtracts nothing rather than everything. */
export function branchWalkQuery(
  branches: readonly BranchListEntry[],
  selected: readonly string[] | null,
  hideRemoteOnly: boolean,
): BranchQuery {
  const hidden = hideRemoteOnly ? remoteOnlyBranchNames(branches) : [];
  return {
    branches: selected === null ? null : [...selected],
    excludeBranches: hidden.length > 0 ? hidden : null,
  };
}

// ─── PR badges (#448) ────────────────────────────────────────────────────────

/** Structural subset of an open PR; matches `OpenPr` from the API layer
 *  without importing it (domain stays dependency-free). */
export interface OpenPrLike {
  number: number;
  headRef: string;
}

/** Open-PR metadata needed to distinguish a base-branch update from another
 * merge into the PR branch. Kept structural so graph classification remains
 * independent from the IPC API layer. */
export interface OpenPrBaseLike extends OpenPrLike {
  baseRef: string;
  /** The GitHub remote selected for this PR fetch, when available. */
  baseRemote?: string | null;
}

/** Return the merge OIDs on open PR first-parent paths that merge the PR's
 * configured base history back into the branch. A ref must be present for both
 * ends of the relationship; a partially loaded graph deliberately produces no
 * guess rather than dimming an unrelated merge. */
export function baseUpdateMergeOids(
  commits: readonly GraphCommitLike[],
  refs: Readonly<Record<string, readonly RefDecorationLike[]>>,
  prs: readonly OpenPrBaseLike[],
): Set<string> {
  const commitsByOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const branchTip = (branch: string, preferredRemote?: string | null): string | null => {
    let localTip: string | null = null;
    let remoteTip: string | null = null;
    for (const [oid, decorations] of Object.entries(refs)) {
      for (const ref of decorations) {
        if (ref.kind === "LocalBranch" && ref.name === branch) localTip = oid;
        if (
          ref.kind === "RemoteBranch" &&
          preferredRemote != null &&
          ref.name === `${preferredRemote}/${branch}`
        ) return oid;
        if (ref.kind === "RemoteBranch" && ref.name.endsWith(`/${branch}`)) remoteTip = oid;
      }
    }
    return localTip ?? remoteTip;
  };
  const reachableFrom = (tip: string): Set<string> => {
    const reachable = new Set<string>();
    const pending = [tip];
    while (pending.length > 0) {
      const oid = pending.pop()!;
      if (reachable.has(oid)) continue;
      reachable.add(oid);
      const commit = commitsByOid.get(oid);
      if (commit) pending.push(...commit.parents);
    }
    return reachable;
  };

  const baseUpdates = new Set<string>();
  for (const pr of prs) {
    const headTip = branchTip(pr.headRef);
    const baseTip = branchTip(pr.baseRef, pr.baseRemote);
    if (!headTip || !baseTip) continue;
    const baseHistory = reachableFrom(baseTip);
    const visited = new Set<string>();
    let oid: string | undefined = headTip;
    while (oid && !visited.has(oid)) {
      visited.add(oid);
      const commit = commitsByOid.get(oid);
      if (!commit) break;
      if (commit.parents.slice(1).some((parent) => baseHistory.has(parent))) {
        baseUpdates.add(oid);
      }
      oid = commit.parents[0];
    }
  }
  return baseUpdates;
}

/** Whether the independently persisted base-update preference applies to an
 * already-classified row. Keeping this decision in the domain makes the view
 * a direct presentation of the toggle rather than a second classifier. */
export function shouldMuteBaseUpdateMerge(
  oid: string,
  baseUpdateOids: ReadonlySet<string>,
  enabled: boolean,
): boolean {
  return enabled && baseUpdateOids.has(oid);
}

/** CI rollup states surfaced on a PR badge (`null` = unknown / no checks). */
export type CiStatus = "success" | "failure" | "pending" | null;

/** Aggregate review states surfaced on a PR badge (`null` = unknown). */
export type ReviewDecision =
  | "approved"
  | "changes_requested"
  | "review_required"
  | null;

/** The presentation-relevant subset of an open PR (structural; avoids
 *  importing the API `OpenPr`, keeping domain dependency-free). */
export interface PrBadgeFields {
  draft?: boolean;
  ciStatus?: CiStatus;
  reviewDecision?: ReviewDecision;
  commentCount?: number | null;
}

/** Everything the badge template needs, derived purely from a PR's status
 *  fields — so the mapping is unit-testable away from the DOM. */
export interface PrBadgePresentation {
  /** CI color modifier class, or `null` to keep the default purple. Draft
   *  PRs always return `null` here so their grey styling wins regardless of
   *  CI state (a draft is "not real yet"). */
  ciClass: "ci-success" | "ci-failure" | "ci-pending" | null;
  /** Review glyph: `"✓"` approved, `"±"` changes requested, else `null`
   *  (review_required and unknown carry no glyph — absence reads as neutral). */
  reviewGlyph: "✓" | "±" | null;
  /** Comment count to show, or `null` to omit (only shown when > 0). */
  commentCount: number | null;
}

function ciClassFor(status: CiStatus | undefined): PrBadgePresentation["ciClass"] {
  switch (status) {
    case "success":
      return "ci-success";
    case "failure":
      return "ci-failure";
    case "pending":
      return "ci-pending";
    default:
      return null;
  }
}

/** Map a PR's status fields to its badge presentation (color + glyphs). Pure;
 *  the single source of truth for how CI/review/comment state becomes visual
 *  decoration on the git-graph PR badge (#459). */
export function prBadgePresentation(pr: PrBadgeFields): PrBadgePresentation {
  const ciClass = pr.draft ? null : ciClassFor(pr.ciStatus);
  const reviewGlyph =
    pr.reviewDecision === "approved"
      ? "✓"
      : pr.reviewDecision === "changes_requested"
        ? "±"
        : null;
  const commentCount =
    pr.commentCount != null && pr.commentCount > 0 ? pr.commentCount : null;
  return { ciClass, reviewGlyph, commentCount };
}

/** Human-readable CI status line for the PR details dropdown, or `null` when
 *  unknown (no token / no checks) so the caller can omit the line. */
export function ciStatusLabel(status: CiStatus | undefined): string | null {
  switch (status) {
    case "success":
      return "Checks passing";
    case "failure":
      return "Checks failing";
    case "pending":
      return "Checks pending";
    default:
      return null;
  }
}

/** Human-readable review-decision line for the dropdown, or `null` to omit. */
export function reviewDecisionLabel(
  decision: ReviewDecision | undefined,
): string | null {
  switch (decision) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "review_required":
      return "Review required";
    default:
      return null;
  }
}

/** A single PR issue comment, as delivered over IPC (#468). Structural subset
 *  of the API `OpenPr`'s comment shape, kept here so the view-model stays
 *  dependency-free and unit-testable. */
export interface PrCommentLike {
  /** Author login, or `null` when the account was deleted. */
  author?: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt?: string | null;
  /** Plain-text comment body. */
  body?: string | null;
}

/** Normalize a PR description for display: trims surrounding whitespace and
 *  collapses an empty/whitespace-only/missing body to `null` so the caller can
 *  omit the description block entirely. Pure. */
export function prDescription(body: string | null | undefined): string | null {
  if (body == null) return null;
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Compact relative time for an arbitrary past instant (#468), used for PR
 *  comment timestamps: "now", "5d", "5w", "5mo", and so on. Future
 *  timestamps (clock skew) read "now". Malformed/missing input returns `null`
 *  so the caller can omit the time. Pure. */
export function relativeTimeFrom(
  createdAt: string | null | undefined,
  nowMs: number,
): string | null {
  if (createdAt == null) return null;
  const thenMs = Date.parse(createdAt);
  if (Number.isNaN(thenMs)) return null;
  return compactRelativeTime(nowMs - thenMs);
}

/** A PR comment prepared for display in the details dropdown. */
export interface PrDetailComment {
  /** Author login, or `"(unknown)"` when the account was deleted. */
  author: string;
  /** Relative time wording, or `null` when the timestamp is unparseable. */
  time: string | null;
  /** Trimmed comment body. */
  body: string;
}

/** Build the displayable comment list for the PR details dropdown (#468):
 *  resolves the author fallback, computes each relative time, trims bodies,
 *  and drops comments whose body is empty after trimming (nothing to show).
 *  Pure — the DOM template just iterates the result. */
export function prDetailComments(
  comments: readonly PrCommentLike[] | null | undefined,
  nowMs: number,
): PrDetailComment[] {
  if (comments == null) return [];
  const result: PrDetailComment[] = [];
  for (const c of comments) {
    const body = (c.body ?? "").trim();
    if (body.length === 0) continue;
    result.push({
      author: c.author?.trim() || "(unknown)",
      time: relativeTimeFrom(c.createdAt, nowMs),
      body,
    });
  }
  return result;
}

/** Index open PRs by their head branch for O(1) badge lookup while
 *  rendering ref chips. When several open PRs share a branch (shouldn't
 *  normally happen, but GitHub doesn't forbid it), the lowest PR number
 *  wins — the oldest/most-likely-canonical one. */
export function indexPrsByBranch<T extends OpenPrLike>(prs: readonly T[]): Map<string, T> {
  const byBranch = new Map<string, T>();
  for (const pr of prs) {
    const existing = byBranch.get(pr.headRef);
    if (!existing || pr.number < existing.number) byBranch.set(pr.headRef, pr);
  }
  return byBranch;
}

/** Combined ref chips (reference behavior): each local branch groups the
 *  remotes tracking it as nested sub-chips; the checked-out branch first;
 *  unmatched remotes and tags stay separate.
 *
 *  `headBranch` is the shorthand of the actually checked-out branch (HEAD's
 *  symbolic target). Only that chip is marked `active` — when several branches
 *  sit on the HEAD commit, the others render as ordinary chips (#433). When
 *  omitted/null (detached HEAD, or callers that don't know), no chip is active. */
export function groupRefChips(
  decorations: readonly RefDecorationLike[],
  headBranch: string | null = null,
): RefChips {
  const isHead = decorations.some((r) => r.kind === "Head");
  const locals = decorations.filter((r) => r.kind === "LocalBranch").map((r) => r.name);
  const remoteNames = decorations.filter((r) => r.kind === "RemoteBranch").map((r) => r.name);
  const usedRemotes = new Set<string>();
  const heads = locals.map((name) => {
    const remotes = remoteNames
      .filter((rn) => rn.slice(rn.indexOf("/") + 1) === name)
      .map((rn) => {
        usedRemotes.add(rn);
        return rn.slice(0, rn.indexOf("/"));
      });
    return { name, remotes, active: isHead && headBranch !== null && name === headBranch };
  });
  heads.sort((a, b) => Number(b.active) - Number(a.active));
  return {
    isHead,
    heads,
    remotes: remoteNames.filter((rn) => !usedRemotes.has(rn)).map(splitRemoteRef),
    tags: decorations.filter((r) => r.kind === "Tag").map((r) => r.name),
  };
}

/** Standing detached-HEAD indicator (#524).
 *
 *  Detached HEAD is a mode, not an event: while it lasts, every commit made
 *  belongs to no branch. The reference tool (keifu) gives it a permanent
 *  white-on-red status treatment for exactly that reason, so the graph needs
 *  a presenter that is independent of the transient checkout menu. */
export interface DetachedHeadIndicator {
  /** Badge text, e.g. `DETACHED HEAD @ 1a2b3c4`. */
  label: string;
  /** Tooltip: what the state means and how to leave it. */
  title: string;
}

/** Abbreviated OID length — 7 hex chars, matching git's default. */
const SHORT_OID_LEN = 7;

/** Present the detached-HEAD state, or `null` when HEAD is on a branch.
 *
 *  `detached` comes from the repository (`git_log`'s payload), never from
 *  `headBranch === null`: that is also true on an unborn branch, where the
 *  warning would be wrong. A missing/blank `headOid` still yields a badge —
 *  the state is what matters, the commit is only ever detail. */
export function detachedHeadIndicator(
  detached: boolean,
  headOid: string | null,
): DetachedHeadIndicator | null {
  if (!detached) return null;
  const short = (headOid ?? "").trim().slice(0, SHORT_OID_LEN);
  const at = short ? ` at ${short}` : "";
  return {
    label: short ? `DETACHED HEAD @ ${short}` : "DETACHED HEAD",
    title: `HEAD is detached${at} — new commits belong to no branch and can be lost. Check out a branch to reattach.`,
  };
}
