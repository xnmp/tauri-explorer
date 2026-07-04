/**
 * Commit-graph lane assignment (#58).
 * Pure functions — no framework or IPC deps.
 *
 * Given commits in topological order (newest first, as `git_log` returns
 * them), assign each commit a lane (column) and produce the edge segments
 * connecting each row to the next. The renderer draws one SVG cell per row:
 * a dot at `lane`, plus `edges` as line segments from this row's baseline
 * to the next row's baseline.
 */

export interface GraphCommitLike {
  oid: string;
  parents: string[];
}

/** An edge segment leaving a row downward: from `from` lane at this row to
 *  `to` lane at the next row. */
export interface GraphEdge {
  from: number;
  to: number;
}

export interface GraphRow {
  /** Lane (column) of this row's commit dot. */
  lane: number;
  /** Segments connecting this row to the next (includes pass-throughs). */
  edges: GraphEdge[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Highest lane index used + 1 — the number of columns to reserve. */
  laneCount: number;
}

/** First free (null) slot, or the end of the array. */
function freeLane(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  if (i !== -1) return i;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Assign lanes top-to-bottom. Each lane tracks the OID it is "waiting for";
 * a commit lands in the lane waiting for it (or a fresh lane for a new tip).
 * Its first parent keeps the lane; extra parents (merges) fork to the lane
 * already waiting for them or to a new lane. Lanes waiting for an OID that
 * another lane also expects collapse into the leftmost lane (branch join).
 */
export function assignLanes(commits: readonly GraphCommitLike[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    // The lane expecting this commit, else a fresh one (new branch tip).
    let lane = lanes.indexOf(commit.oid);
    if (lane === -1) lane = freeLane(lanes);

    // Any OTHER lanes waiting for this same commit join into `lane` here.
    const joins: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.oid) {
        joins.push(i);
        lanes[i] = null;
      }
    }

    const edges: GraphEdge[] = [];
    for (const j of joins) edges.push({ from: j, to: lane });

    const [first, ...rest] = commit.parents;
    if (first !== undefined) {
      // If another lane already waits for our first parent, the two lines
      // join — collapse into the LEFTMOST lane (conventional rendering).
      const existing = lanes.findIndex((o, i) => i !== lane && o === first);
      if (existing !== -1 && existing < lane) {
        lanes[lane] = null;
        edges.push({ from: lane, to: existing });
      } else if (existing !== -1) {
        lanes[existing] = null;
        lanes[lane] = first;
        edges.push({ from: lane, to: lane });
        edges.push({ from: existing, to: lane });
      } else {
        lanes[lane] = first;
        edges.push({ from: lane, to: lane });
      }
    } else {
      lanes[lane] = null; // root commit — line ends here
    }

    for (const parent of rest) {
      const existing = lanes.indexOf(parent);
      if (existing !== -1) {
        edges.push({ from: lane, to: existing });
      } else {
        const nl = freeLane(lanes);
        lanes[nl] = parent;
        edges.push({ from: lane, to: nl });
      }
    }

    // Pass-throughs: every other occupied lane continues straight down.
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null && i !== lane && !edges.some((e) => e.from === i || e.to === i)) {
        edges.push({ from: i, to: i });
      }
    }

    laneCount = Math.max(laneCount, lane + 1, lanes.length);
    rows.push({ lane, edges });
  }

  return { rows, laneCount };
}

/** Deterministic per-lane colour index (renderer maps to a palette). */
export function laneColorIndex(lane: number, paletteSize: number): number {
  return lane % Math.max(1, paletteSize);
}
