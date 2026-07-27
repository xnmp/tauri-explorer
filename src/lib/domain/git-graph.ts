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
 * - Lanes are claimed greedily left-to-right per row, first come first served.
 * - Once a line occupies a lane it stays there while the lane is free, so
 *   lines run parallel and cross over in a single row at their destination
 *   instead of drifting left as lanes free up.
 */

export interface GraphCommitLike {
  oid: string;
  parents: string[];
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
  return { colorIndex: line.colorIndex, points: pts.slice(first, last + 1) };
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

interface VertexState {
  parents: number[]; // indices into commits (-1 when parent not in page)
  nextParent: number; // next parent edge to route
  onBranch: number | null; // colorIndex of the branch this vertex sits on
  lane: number | null;
  nextFreeLane: number; // greedy per-row lane cursor
  /** lane → reservation key "parentRow:branchId" on this row. */
  reserved: Map<number, string>;
}

export function assignLayout(commits: readonly GraphCommitLike[]): GraphLayout {
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
      v.lane = claimPoint(row, null);
      reserve(row, v.lane, `dot:${row}`);
    }
    return v.lane;
  }

  /** Route the next unprocessed parent edge of the vertex at `startRow`. */
  function determinePath(startRow: number): void {
    const start = vertices[startRow];
    const parentIdx = start.nextParent;
    const parentRow = start.parents[parentIdx] ?? -1;
    const isFirstParent = parentIdx === 0;
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
          lane = placeDot(row);
        } else {
          lane = claimPoint(row, id, prevLane);
          reserve(row, lane, id);
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
        lane = placeDot(row);
      } else {
        lane = claimPoint(row, id, prevLane);
        reserve(row, lane, id);
      }
      line.points.push({ lane, row });
      prevLane = lane;

      if (!isTarget) continue;
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
 * Direction of a jump along a branch line, stated in commit age rather than
 * screen direction so it stays true however the graph is ordered: `"older"`
 * follows the first-parent edge toward ancestors, `"newer"` walks back toward
 * the commit that claims this one as ITS first parent.
 */
export type BranchLineDirection = "older" | "newer";

/**
 * Row of the neighbouring commit on the SAME branch line as `fromRow` (#530),
 * or -1 when there is none on the loaded page.
 *
 * "Branch line" means what `assignLayout` draws as one continuous polyline: an
 * uninterrupted FIRST-PARENT chain. Following it is what lets a jump skip the
 * rows physically in between that belong to other lines, which is the whole
 * point of the shortcut.
 *
 * Deliberate edges:
 * - Only `parents[0]` is followed, so a merge commit steps onto its own line,
 *   never into the branch it merged in.
 * - A parent that is not on the loaded page (truncated history, filtered
 *   branches) is not a target — the jump stops rather than silently landing on
 *   an unrelated row.
 * - `"older"` only ever looks DOWN the list and `"newer"` only UP, so a
 *   non-topological ordering can never produce a backwards jump or a cycle.
 * - When several commits share one first parent (two branches rooted at the
 *   same commit) `"newer"` picks the nearest one above, i.e. the closest jump.
 */
export function stepOnBranchLine(
  commits: readonly GraphCommitLike[],
  fromRow: number,
  direction: BranchLineDirection,
): number {
  void commits;
  void fromRow;
  void direction;
  return -1;
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

// ─── PR badges (#448) ────────────────────────────────────────────────────────

/** Structural subset of an open PR; matches `OpenPr` from the API layer
 *  without importing it (domain stays dependency-free). */
export interface OpenPrLike {
  number: number;
  headRef: string;
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

/** Relative-time wording for an arbitrary past instant (#468), used for PR
 *  comment timestamps: "just now", "N minute(s) ago" … up to "N year(s) ago".
 *  Future timestamps (clock skew) read "just now". Malformed/missing input
 *  returns `null` so the caller can omit the time. Pure. */
export function relativeTimeFrom(
  createdAt: string | null | undefined,
  nowMs: number,
): string | null {
  if (createdAt == null) return null;
  const thenMs = Date.parse(createdAt);
  if (Number.isNaN(thenMs)) return null;
  const ageSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (ageSec < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [30, "month"],
    [12, "year"],
  ];
  // Walk up the ladder: minutes → hours → days → months → years.
  let value = Math.floor(ageSec / 60); // minutes
  let label = "minute";
  for (let i = 1; i < units.length; i++) {
    const [divisor, name] = units[i];
    if (value < divisor) break;
    value = Math.floor(value / divisor);
    label = name;
  }
  return `${value} ${label}${value === 1 ? "" : "s"} ago`;
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
