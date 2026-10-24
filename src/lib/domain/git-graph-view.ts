/**
 * Geometry for the git graph's virtualized table (#256, #341, #221). Pure:
 * GitGraphView supplies measured viewport values and renders the results.
 *
 * Rows sit at a fixed pitch; an open inline expansion (commit details or the
 * PR dropdown) pushes every row after it down by `RowExpand.extra`.
 */
import { compactRelativeTimeToday } from "./git";
import { sliceBranchLine, type BranchLine, type RowExpand } from "./git-graph";

export const GRAPH_ROW_HEIGHT = 28;
export const GRAPH_LANE_WIDTH = 14;
/** Rows rendered beyond each edge of the viewport. */
export const GRAPH_OVERSCAN = 12;

/** The synthetic "Uncommitted Changes (N)" row shown above HEAD. */
export interface UncommittedRow {
  readonly oid: string;
  readonly short_oid: string;
  readonly parents: readonly string[];
  readonly author_name: string;
  readonly author_email: string;
  readonly author_time: number;
  readonly summary: string;
}

/** Rows fed to layout/render: a synthetic uncommitted-changes row on top when
 *  the working tree is dirty, HEAD is loaded and no file-path filter narrows
 *  the history (#466, #529), then the loaded page. */
export function withUncommittedRow<T>(
  commits: readonly T[],
  input: { oid: string; workingChanges: number; headOid: string | null; filePath: string; nowMs: number },
): readonly (T | UncommittedRow)[] {
  const { oid, workingChanges, headOid, filePath, nowMs } = input;
  if (!(workingChanges > 0 && headOid && !filePath.trim())) return commits;
  return [
    {
      oid,
      short_oid: oid,
      parents: [headOid],
      author_name: "*",
      author_email: "",
      author_time: Math.floor(nowMs / 1000),
      summary: `Uncommitted Changes (${workingChanges})`,
    },
    ...commits,
  ];
}

// One shared formatter: constructing Intl state per row per render is a
// measurable cost at hundreds of rows (#256).
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/** Commit date cell text: today's commits read as an age ("5 minutes ago",
 *  #389); older ones keep the date. */
export function formatGraphDate(unixSeconds: number, nowMs: number): string {
  return compactRelativeTimeToday(unixSeconds, nowMs) ?? dateFormatter.format(new Date(unixSeconds * 1000));
}

/** Row index at a vertical offset, accounting for the inline expansion. */
export function rowAtY(y: number, rowHeight: number, expand?: RowExpand): number {
  let offset = y;
  if (expand) {
    const expandTop = (expand.afterRow + 1) * rowHeight;
    if (offset >= expandTop) offset = Math.max(expandTop, offset - expand.extra);
  }
  return Math.floor(offset / rowHeight);
}

/** Pixel offset of a row, accounting for the inline expansion above it. */
export function rowY(index: number, rowHeight: number, expand?: RowExpand): number {
  return index * rowHeight + (expand && index > expand.afterRow ? expand.extra : 0);
}

/** The inclusive row range to render for a scroll position. */
export function renderWindow(input: {
  scrollTop: number;
  viewportHeight: number;
  rowCount: number;
  rowHeight: number;
  overscan: number;
  expand?: RowExpand;
}): { startRow: number; endRow: number } {
  const { scrollTop, viewportHeight, rowCount, rowHeight, overscan, expand } = input;
  return {
    startRow: Math.max(0, rowAtY(scrollTop, rowHeight, expand) - overscan),
    endRow: Math.min(rowCount - 1, rowAtY(scrollTop + viewportHeight, rowHeight, expand) + overscan),
  };
}

const clipToWindow = (startRow: number, endRow: number) =>
  (line: BranchLine) => sliceBranchLine(line, startRow - 2, endRow + 2);
const present = (line: BranchLine | null): line is BranchLine => line !== null;

/** Lane geometry clipped to the rendered rows. Lines keep a two-row margin
 *  so edges entering the window are drawn; the dashed uncommitted line is
 *  kept whole because the renderer splits it at HEAD by object identity.
 *  Independent of the hovered trace, so hover does not re-window lanes. */
export function windowGraphGeometry<V>(input: {
  branches: readonly BranchLine[];
  vertices: readonly V[];
  uncommittedBranch: BranchLine | undefined;
  startRow: number;
  endRow: number;
}): {
  branches: BranchLine[];
  vertices: { vertex: V; vi: number }[];
} {
  const { startRow, endRow, uncommittedBranch } = input;
  const clip = clipToWindow(startRow, endRow);
  return {
    branches: input.branches
      .map((line) => (line === uncommittedBranch ? line : clip(line)))
      .filter(present),
    vertices: input.vertices
      .slice(startRow, endRow + 1)
      .map((vertex, i) => ({ vertex, vi: startRow + i })),
  };
}

/** Traced-lineage segments clipped to the rendered rows (same margin). */
export function windowTraceSegments(
  segments: readonly BranchLine[] | null,
  startRow: number,
  endRow: number,
): BranchLine[] {
  return segments === null ? [] : segments.map(clipToWindow(startRow, endRow)).filter(present);
}

/** SVG stretch below an open inline block, or undefined when none is open
 *  or it has not been measured yet. +6 is the block's bottom gap (its
 *  margin-bottom is outside offsetHeight). */
export function inlineRowExpand(expandedIndex: number, measuredHeight: number): RowExpand | undefined {
  return expandedIndex >= 0 && measuredHeight > 0
    ? { afterRow: expandedIndex, extra: measuredHeight + 6 }
    : undefined;
}

/** Split the uncommitted branch line at HEAD: `dirty` ([0, headRowInLine])
 *  renders gray dashed; `rest` renders in its branch colour. A HEAD row the
 *  line never reaches still splits after its first segment. */
export function splitUncommittedLine(
  line: BranchLine,
  headRow: number,
): { dirty: BranchLine; rest: BranchLine } {
  const split = Math.max(1, line.points.findIndex((point) => point.row === headRow));
  return {
    dirty: { colorIndex: line.colorIndex, points: line.points.slice(0, split + 1) },
    rest: { colorIndex: line.colorIndex, points: line.points.slice(split) },
  };
}

export interface GraphColumnWidths {
  graph: number;
  /** null when the column is hidden. */
  author: number | null;
  date: number | null;
  commit: boolean;
  parent: boolean;
}

/** Narrowest table that keeps a usable message region and every configured
 *  metadata width; narrower panes scroll horizontally instead of letting ref
 *  badges displace columns. Avatars deliberately do not raise this minimum:
 *  they borrow from the message cell. */
export function minimumGraphTableWidth(columns: GraphColumnWidths): number {
  return columns.graph + 20 + 14 + 160
    + (columns.author !== null ? columns.author + 8 : 0)
    + (columns.date !== null ? columns.date + 8 : 0)
    + (columns.commit ? 60 + 8 + 8 : 0)
    + (columns.parent ? 120 + 8 + 8 : 0);
}

/** Pull a fixed-position menu back inside the viewport (VSCode behaviour).
 *  All values are in the same fixed-CSS space. */
export function clampMenuPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  pad = 8,
): { x: number; y: number } {
  let { x, y } = position;
  if (x + size.width > viewport.width - pad) x = Math.max(pad, viewport.width - size.width - pad);
  if (y + size.height > viewport.height - pad) y = Math.max(pad, viewport.height - size.height - pad);
  return { x, y };
}
