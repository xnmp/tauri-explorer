/**
 * Branch-line jump row math (#530) — `stepOnBranchLine`.
 *
 * Own file so the 582-line `git-graph.test.ts` layout suite stays untouched.
 * Everything here asserts on RETURNED ROW INDICES over hand-built topologies,
 * which is the value the Ctrl+Up/Down shortcut ultimately moves the selection
 * to; the DOM-level consequence is pinned in `e2e/git-graph-branch-line-jump.spec.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  assignLayout,
  stepOnBranchLine,
  scrollTopToReveal,
  traceGraphLineage,
} from "$lib/domain/git-graph";
import type { BranchLineCommitLike, GraphCommitLike } from "$lib/domain/git-graph";

const c = (oid: string, ...parents: string[]): GraphCommitLike => ({ oid, parents });
/** A woven stash row: its first parent is the commit it was taken from. */
const stashRow = (oid: string, base: string): BranchLineCommitLike => ({
  oid,
  parents: [base],
  stash: "stash@{0}",
});

/**
 * The mock repo's real shape (`MOCK_GRAPH_SPEC`), newest-first, as the graph
 * renders it: a synthetic uncommitted row, a woven stash row, then history.
 * The tip's first-parent line is 16 → 15 → 12 → 11 → 8 → 7 … ; commits 14, 13,
 * 10 and 9 sit physically between those rows on other lines.
 */
const MOCK_ROWS: BranchLineCommitLike[] = [
  c("*", "16"), // 0  synthetic uncommitted changes
  stashRow("stash", "16"), // 1  woven stash entry
  c("16", "15", "13"), // 2  Merge hotfix into main
  c("15", "12", "14"), // 3  Merge experiment
  c("14", "9"), // 4  Try alternative parser
  c("13", "7"), // 5  Hotfix: crash on empty input
  c("12", "11", "10"), // 6  Merge branch 'feature'
  c("11", "8"), // 7  Update README with usage
  c("10", "9"), // 8  Add tests for feature X
  c("9", "8"), // 9  Implement feature X
  c("8", "7"), // 10 Refactor config loader
  c("7", "6"), // 11 Fix bug in argument parser
  c("6"), // 12 (root of the loaded page — parent off-page)
];

describe("stepOnBranchLine — older (down the first-parent line)", () => {
  it("walks a linear history one row at a time", () => {
    const rows = [c("c", "b"), c("b", "a"), c("a")];
    expect(stepOnBranchLine(rows, 0, "older")).toBe(1);
    expect(stepOnBranchLine(rows, 1, "older")).toBe(2);
  });

  it("skips the rows between a commit and its first parent", () => {
    // Row 3 (commit 15) → row 6 (commit 12), stepping over 14 and 13.
    expect(stepOnBranchLine(MOCK_ROWS, 3, "older")).toBe(6);
  });

  it("follows a merge commit's FIRST parent, never the merged-in branch", () => {
    // 16's parents are [15, 13]. 13 is row 5; the jump must land on 15 (row 3).
    expect(stepOnBranchLine(MOCK_ROWS, 2, "older")).toBe(3);
    // Same for 12 = [11, 10]: row 7 (11), not row 8 (10).
    expect(stepOnBranchLine(MOCK_ROWS, 6, "older")).toBe(7);
  });

  it("steps the synthetic uncommitted row onto HEAD, skipping the stash row", () => {
    expect(stepOnBranchLine(MOCK_ROWS, 0, "older")).toBe(2);
  });

  it("stops at a root commit (no parents)", () => {
    const rows = [c("b", "a"), c("a")];
    expect(stepOnBranchLine(rows, 1, "older")).toBe(-1);
  });

  it("stops when the first parent is not on the loaded page", () => {
    // Truncated history: row 12's parent was never loaded.
    expect(stepOnBranchLine(MOCK_ROWS, 12, "older")).toBe(-1);
    expect(stepOnBranchLine([c("tip", "not-loaded")], 0, "older")).toBe(-1);
  });

  it("never jumps upwards, even if an oid matching the first parent sits above", () => {
    // Hostile / non-topological ordering: the parent appears ABOVE the child.
    const rows = [c("a"), c("b", "a")];
    expect(stepOnBranchLine(rows, 1, "older")).toBe(-1);
  });
});

describe("stepOnBranchLine — newer (back up the first-parent line)", () => {
  it("returns the commit that claims this one as its first parent", () => {
    // Row 6 (commit 12) → row 3 (commit 15), stepping back over 13 and 14.
    expect(stepOnBranchLine(MOCK_ROWS, 6, "newer")).toBe(3);
    expect(stepOnBranchLine(MOCK_ROWS, 3, "newer")).toBe(2);
  });

  it("ignores commits that reach it only through a NON-first parent", () => {
    // 14 (row 4) is 15's SECOND parent, and nothing else claims it, so 14 has
    // no newer neighbour on its own line.
    expect(stepOnBranchLine(MOCK_ROWS, 4, "newer")).toBe(-1);
    // Likewise 13 (row 5) is only 16's second parent.
    expect(stepOnBranchLine(MOCK_ROWS, 5, "newer")).toBe(-1);
    // …and 10 (row 8) is only 12's second parent.
    expect(stepOnBranchLine(MOCK_ROWS, 8, "newer")).toBe(-1);
  });

  it("stops at the top of the line", () => {
    expect(stepOnBranchLine(MOCK_ROWS, 0, "newer")).toBe(-1);
  });

  it("steps over a woven stash row to the trunk row above it", () => {
    // The stash's first parent IS commit 16, so it looks like an on-line
    // neighbour — but it is drawn on its own lane. Jumping onto it would be a
    // dead end AND would hide the uncommitted row directly above.
    expect(stepOnBranchLine(MOCK_ROWS, 2, "newer")).toBe(0);
  });

  it("still steps OFF a stash row down to its base commit", () => {
    expect(stepOnBranchLine(MOCK_ROWS, 1, "older")).toBe(2);
  });

  it("picks the NEAREST commit above when two branches share a first parent", () => {
    // Both b and d claim a as their first parent; d is closer to a.
    const rows = [c("b", "a"), c("d", "a"), c("a")];
    expect(stepOnBranchLine(rows, 2, "newer")).toBe(1);
  });

  it("never jumps downwards", () => {
    const rows = [c("a"), c("b", "a")];
    expect(stepOnBranchLine(rows, 0, "newer")).toBe(-1);
  });
});

describe("stepOnBranchLine — hostile input", () => {
  it("treats an absent or out-of-range selection as no move", () => {
    for (const dir of ["older", "newer"] as const) {
      expect(stepOnBranchLine(MOCK_ROWS, -1, dir)).toBe(-1);
      expect(stepOnBranchLine(MOCK_ROWS, MOCK_ROWS.length, dir)).toBe(-1);
      expect(stepOnBranchLine(MOCK_ROWS, 9999, dir)).toBe(-1);
      expect(stepOnBranchLine(MOCK_ROWS, 1.5, dir)).toBe(-1);
      expect(stepOnBranchLine(MOCK_ROWS, Number.NaN, dir)).toBe(-1);
      expect(stepOnBranchLine([], 0, dir)).toBe(-1);
    }
  });

  it("survives malformed rows without throwing or matching undefined to undefined", () => {
    const malformed = [
      { oid: "x", parents: [] as string[] },
      { oid: "", parents: [""] },
      { parents: ["x"] } as unknown as GraphCommitLike,
      { oid: "y" } as unknown as GraphCommitLike,
    ];
    for (let row = 0; row < malformed.length; row++) {
      for (const dir of ["older", "newer"] as const) {
        expect(() => stepOnBranchLine(malformed, row, dir)).not.toThrow();
        expect(stepOnBranchLine(malformed, row, dir)).toBe(-1);
      }
    }
  });
});

describe("traceGraphLineage — observable branch trace", () => {
  it("includes first-parent ancestry and same-lane descendants, but not unrelated rows", () => {
    const layout = assignLayout(MOCK_ROWS, "16");
    const trace = traceGraphLineage(MOCK_ROWS, layout, 8); // feature tip #10

    expect([...trace.rows].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12]);
    expect(trace.rows.has(5)).toBe(false); // hotfix
    expect(trace.rows.has(6)).toBe(false); // trunk merge that absorbs #10
    expect(trace.rows.has(7)).toBe(false); // unrelated trunk child of #8
  });

  it("returns exact lineage geometry, including shared ancestry and the absorbing merge edge", () => {
    const layout = assignLayout(MOCK_ROWS, "16");
    const trace = traceGraphLineage(MOCK_ROWS, layout, 8);

    const containsVertex = (segment: (typeof trace.segments)[number], row: number) => {
      const vertex = layout.vertices[row];
      return segment.points.some((point) => point.row === row && point.lane === vertex.lane);
    };

    const hasConnection = (childRow: number, parentRow: number) =>
      trace.segments.some(
        (segment) => containsVertex(segment, childRow) && containsVertex(segment, parentRow),
      );
    // Feature edges #10 → #9 → #8 and shared-trunk ancestry #8 → #7 → #6.
    expect(hasConnection(8, 9)).toBe(true);
    expect(hasConnection(9, 10)).toBe(true);
    expect(hasConnection(10, 11)).toBe(true);
    expect(hasConnection(11, 12)).toBe(true);
    // The merge arc #12 → #10 completes the visual absorption of the feature line.
    expect(
      trace.segments.some(
        (segment) =>
          segment.mergeEdge === true &&
          segment.points[0]?.row === 6 &&
          segment.points.at(-1)?.row === 8,
      ),
    ).toBe(true);
    // The hotfix branch remains outside the highlighted geometry.
    expect(trace.segments.some((segment) => containsVertex(segment, 5))).toBe(false);
  });

  it("walks newer commits only while they remain on the selected layout lane", () => {
    const rows = [
      c("merge", "main", "feature-tip"),
      c("feature-tip", "feature-base"),
      c("main", "base"),
      c("feature-base", "base"),
      c("base"),
    ];
    const layout = assignLayout(rows, "main");
    const trace = traceGraphLineage(rows, layout, 3);

    expect([...trace.rows].sort((a, b) => a - b)).toEqual([1, 3, 4]);
    expect(trace.rows.has(0)).toBe(false); // merge reaches feature-tip only as parent[1]
    expect(trace.rows.has(2)).toBe(false); // parallel main lane
  });

  it("returns no trace for missing, malformed, or truncated selections", () => {
    const layout = assignLayout(MOCK_ROWS, "16");
    expect(traceGraphLineage(MOCK_ROWS, layout, -1)).toEqual({
      rows: new Set(),
      segments: [],
    });
    expect(traceGraphLineage(MOCK_ROWS, layout, 9999)).toEqual({
      rows: new Set(),
      segments: [],
    });
    expect(
      traceGraphLineage(
        [{ oid: "", parents: [] }],
        { vertices: [{ lane: 0, colorIndex: 0 }], branches: [], laneCount: 1 },
        0,
      ),
    ).toEqual({ rows: new Set(), segments: [] });

    const truncated = [c("tip", "not-loaded")];
    expect(traceGraphLineage(truncated, assignLayout(truncated), 0)).toEqual({
      rows: new Set([0]),
      segments: [],
    });

    const malformedRows = [
      null as unknown as GraphCommitLike,
      { oid: "valid", parents: null } as unknown as GraphCommitLike,
    ];
    const malformedLayout = {
      vertices: [
        { lane: Number.NaN, colorIndex: 0 },
        { lane: 0, colorIndex: 0 },
      ],
      branches: [{ colorIndex: 0, points: [null] }] as unknown as ReturnType<
        typeof assignLayout
      >["branches"],
      laneCount: 1,
    };
    expect(() => traceGraphLineage(malformedRows, malformedLayout, 1)).not.toThrow();
    expect(traceGraphLineage(malformedRows, malformedLayout, 1)).toEqual({
      rows: new Set([1]),
      segments: [],
    });
    expect(
      traceGraphLineage(MOCK_ROWS, null as unknown as ReturnType<typeof assignLayout>, 0),
    ).toEqual({ rows: new Set(), segments: [] });
  });

  it("classifies a deep two-lane history within an interactive hover budget", () => {
    const size = 3_001;
    const rows: GraphCommitLike[] = [];
    const vertices: ReturnType<typeof assignLayout>["vertices"] = [];
    for (let row = 0; row < size; row++) {
      if (row === size - 1) {
        rows.push(c("root"));
        vertices.push({ lane: 0, colorIndex: 0 });
      } else if (row % 2 === 0) {
        rows.push(c(`main-${row}`, row + 2 < size - 1 ? `main-${row + 2}` : "root"));
        vertices.push({ lane: 0, colorIndex: 0 });
      } else {
        rows.push(c(`feature-${row}`, row + 2 < size - 1 ? `feature-${row + 2}` : "root"));
        vertices.push({ lane: 1, colorIndex: 1 });
      }
    }
    const layout = {
      vertices,
      branches: [
        {
          colorIndex: 0,
          points: Array.from({ length: size }, (_, row) => ({ row, lane: 0 })),
        },
        {
          colorIndex: 1,
          points: Array.from({ length: size - 1 }, (_, index) => ({
            row: index + 1,
            lane: index === size - 2 ? 0 : 1,
          })),
        },
      ],
      laneCount: 2,
    };

    const started = performance.now();
    const trace = traceGraphLineage(rows, layout, 1_500);
    const elapsed = performance.now() - started;

    expect(trace.rows.has(0)).toBe(true);
    expect(trace.rows.has(1)).toBe(false);
    expect(trace.rows.has(size - 1)).toBe(true);
    expect(trace.segments.length).toBeGreaterThan(0);
    // The prior repeated branch/point scan took ~800 ms at this size.
    expect(elapsed).toBeLessThan(150);
  });
});

describe("scrollTopToReveal — bringing a jump target into the render window", () => {
  const ROW = 28;
  const VIEW = 280; // 10 rows

  it("leaves a fully visible row alone", () => {
    expect(scrollTopToReveal(0, ROW, 0, VIEW)).toBe(0);
    expect(scrollTopToReveal(140, ROW, 0, VIEW)).toBe(0);
    // Exactly flush with the bottom edge still counts as visible.
    expect(scrollTopToReveal(VIEW - ROW, ROW, 0, VIEW)).toBe(0);
  });

  it("scrolls the minimum distance to reveal a row above the window", () => {
    expect(scrollTopToReveal(280, ROW, 560, VIEW)).toBe(280);
  });

  it("scrolls the minimum distance to reveal a row below the window", () => {
    // Row 40 of a page far below the window: its bottom lands on the viewport
    // bottom, so the jump target sits at the last visible row, not the first.
    expect(scrollTopToReveal(40 * ROW, ROW, 0, VIEW)).toBe(41 * ROW - VIEW);
  });

  it("never scrolls to a negative offset", () => {
    expect(scrollTopToReveal(-50, ROW, 100, VIEW)).toBe(0);
  });

  it("leaves an unmeasured viewport untouched", () => {
    expect(scrollTopToReveal(9999, ROW, 42, 0)).toBe(42);
  });
});

describe("stepOnBranchLine — invariants over 300 rows of randomized topology", () => {
  /** Same generator as the assignLayout fuzz case, so both suites see the
   *  same class of hostile-but-valid histories. */
  function fuzzHistory(): GraphCommitLike[] {
    const commits: GraphCommitLike[] = [];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 300; i++) {
      const parents: string[] = [];
      const maxParent = Math.min(299, i + 1 + Math.floor(rand() * 10));
      if (i < 299) parents.push(`c${Math.min(299, i + 1 + Math.floor(rand() * 5))}`);
      if (rand() > 0.8 && maxParent > i + 1) parents.push(`c${maxParent}`);
      commits.push({ oid: `c${i}`, parents });
    }
    return commits;
  }

  it("only ever returns a real first-parent edge, in the right direction", () => {
    const commits = fuzzHistory();
    for (let row = 0; row < commits.length; row++) {
      const older = stepOnBranchLine(commits, row, "older");
      if (older !== -1) {
        expect(older).toBeGreaterThan(row);
        expect(commits[older].oid).toBe(commits[row].parents[0]);
      }
      const newer = stepOnBranchLine(commits, row, "newer");
      if (newer !== -1) {
        expect(newer).toBeLessThan(row);
        expect(commits[newer].parents[0]).toBe(commits[row].oid);
      }
    }
  });

  it("round-trips: stepping older then newer lands back on this commit's line", () => {
    const commits = fuzzHistory();
    for (let row = 0; row < commits.length; row++) {
      const older = stepOnBranchLine(commits, row, "older");
      if (older === -1) continue;
      const back = stepOnBranchLine(commits, older, "newer");
      // `row` is itself a candidate, so a return jump always exists; and since
      // the NEAREST candidate above wins, it can never overshoot past `row`
      // into unrelated history — it lands somewhere in [row, older).
      expect(back).toBeGreaterThanOrEqual(row);
      expect(back).toBeLessThan(older);
      expect(commits[back].parents[0]).toBe(commits[older].oid);
    }
  });
});
