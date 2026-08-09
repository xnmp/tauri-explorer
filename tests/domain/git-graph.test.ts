/**
 * Commit-graph vertex/branch layout (#58, #179).
 * Invariants over hostile topologies: continuous branch polylines (no gaps),
 * branch-owned colors with reuse, merge-edge snapping, greedy lane claiming.
 */

import { describe, it, expect } from "vitest";
import {
  assignLayout,
  branchPath,
  groupRefChips,
  indexPrsByBranch,
  baseUpdateMergeOids,
  shouldMuteBaseUpdateMerge,
  prBadgePresentation,
  ciStatusLabel,
  reviewDecisionLabel,
  prDescription,
  relativeTimeFrom,
  prDetailComments,
  GRAPH_PALETTE,
} from "$lib/domain/git-graph";
import type {
  GraphCommitLike,
  OpenPrLike,
  OpenPrBaseLike,
  CiStatus,
  ReviewDecision,
} from "$lib/domain/git-graph";

const c = (oid: string, ...parents: string[]): GraphCommitLike => ({ oid, parents });

/** Every branch polyline must advance one row per point — no gaps. */
function expectContinuous(layout: ReturnType<typeof assignLayout>): void {
  for (const line of layout.branches) {
    for (let i = 1; i < line.points.length; i++) {
      expect(line.points[i].row).toBe(line.points[i - 1].row + 1);
    }
  }
}

describe("assignLayout", () => {
  it("lays a linear history on one lane as one continuous branch", () => {
    const layout = assignLayout([c("c3", "c2"), c("c2", "c1"), c("c1")]);
    expect(layout.laneCount).toBe(1);
    expect(layout.vertices.map((v) => v.lane)).toEqual([0, 0, 0]);
    // One chain covering all three rows with one color.
    const chain = layout.branches.find((b) => b.points.length === 3);
    expect(chain).toBeDefined();
    expect(new Set(layout.vertices.map((v) => v.colorIndex)).size).toBe(1);
    expectContinuous(layout);
  });

  it("pins the checked-out branch first-parent line to lane zero after checkout", () => {
    const commits = [
      c("feature2", "base"),
      c("main2", "main1"),
      c("main1", "base"),
      c("base"),
    ];

    const mainLayout = assignLayout(commits, "main2");
    expect(mainLayout.vertices.map((v) => v.lane)).toEqual([1, 0, 0, 0]);

    const featureLayout = assignLayout(commits, "feature2");
    expect(featureLayout.vertices.map((v) => v.lane)).toEqual([0, 1, 1, 0]);
  });

  it("pins a detached HEAD first-parent line to lane zero", () => {
    const layout = assignLayout([
      c("branchTip", "base"),
      c("detached", "detachedParent"),
      c("detachedParent", "base"),
      c("base"),
    ], "detached");

    expect(layout.vertices.map((v) => v.lane)).toEqual([1, 0, 0, 0]);
  });

  it("keeps lane zero reserved after a working-tree row joins HEAD", () => {
    const layout = assignLayout([
      c("uncommitted", "head"),
      c("otherTip", "base"),
      c("head", "parent"),
      c("otherMiddle", "base"),
      c("parent", "base"),
      c("base"),
    ], "head");

    const lineThroughHead = layout.branches.find(
      (line) => line.points[0]?.row === 0 && line.points.at(-1)?.row === 5,
    );
    expect(lineThroughHead?.points.slice(2).map((point) => point.lane)).toEqual([0, 0, 0, 0]);
  });

  it("routes a merge as an edge into a second lane and joins at the fork", () => {
    // m3 = merge of m2 (main) and f2 (feature); both descend from base.
    const layout = assignLayout([c("m3", "m2", "f2"), c("f2", "base"), c("m2", "base"), c("base")]);
    expect(layout.laneCount).toBe(2);
    const [m3, f2, m2, base] = layout.vertices;
    expect(m3.lane).toBe(0);
    expect(m2.lane).toBe(0);
    expect(base.lane).toBe(0);
    expect(f2.lane).toBe(1);
    // The feature commit's chain has its own color; main keeps color 0.
    expect(f2.colorIndex).not.toBe(m3.colorIndex);
    expectContinuous(layout);
  });

  it("keeps the child's color on a first-parent edge into an existing branch (#368)", () => {
    // Same topology as above: f2's first-parent edge descends into base,
    // which already sits on main's line. The edge must stay in f2's color —
    // painting it in base's color flipped the branch tail blue→orange.
    const layout = assignLayout([c("m3", "m2", "f2"), c("f2", "base"), c("m2", "base"), c("base")]);
    const [, f2] = layout.vertices;
    const edge = layout.branches.find(
      (b) => b.points[0]?.row === 1 && b.points[b.points.length - 1]?.row === 3,
    );
    expect(edge).toBeDefined();
    expect(edge!.colorIndex).toBe(f2.colorIndex);
  });

  it("gives an uncolored tip a fresh color when its only edge joins an existing branch (#368)", () => {
    // tip's first parent is base, already on main's chain drawn from m2.
    const layout = assignLayout([c("m2", "base"), c("tip", "base"), c("base")]);
    const [m2, tip] = layout.vertices;
    expect(tip.colorIndex).not.toBe(m2.colorIndex);
  });

  it("colors belong to branches and are reused once the branch ends", () => {
    // Two disjoint linear histories, one after the other: second reuses color 0.
    const layout = assignLayout([c("a2", "a1"), c("a1"), c("b2", "b1"), c("b1")]);
    expect(layout.vertices[0].colorIndex).toBe(0);
    expect(layout.vertices[2].colorIndex).toBe(0); // reuse — a's line ended above
    expectContinuous(layout);
  });

  it("concurrent branches get distinct colors", () => {
    // tipA and tipB both alive until the shared base at the bottom.
    const layout = assignLayout([c("tipA", "base"), c("tipB", "base"), c("base")]);
    expect(layout.vertices[0].colorIndex).not.toBe(layout.vertices[1].colorIndex);
    expectContinuous(layout);
  });

  it("octopus merges route one edge per extra parent", () => {
    const layout = assignLayout([c("m", "p1", "p2", "p3"), c("p1"), c("p2"), c("p3")]);
    // Chain to p1 + two merge edges to p2/p3 → three lines starting at row 0.
    const fromTop = layout.branches.filter((b) => b.points[0]?.row === 0);
    expect(fromTop.length).toBe(3);
    expectContinuous(layout);
  });

  it("handles criss-cross merges without gaps or invalid lanes", () => {
    // a2 merges (a1,b1); b2 merges (b1,a1) — the classic criss-cross.
    const layout = assignLayout([
      c("a2", "a1", "b1"),
      c("b2", "b1", "a1"),
      c("a1", "base"),
      c("b1", "base"),
      c("base"),
    ]);
    expectContinuous(layout);
    for (const v of layout.vertices) {
      expect(v.lane).toBeGreaterThanOrEqual(0);
      expect(v.lane).toBeLessThan(layout.laneCount);
    }
  });

  it("keeps a long edge in its lane and crosses only at the destination row", () => {
    // m is an octopus merge. The edge m→f spans rows 1-3; the edge m→q ends
    // at row 2, freeing lane 1 below it. The m→f edge must NOT drift left
    // into the freed lane — it stays parallel in its own lane and crosses to
    // f's lane in the final row only.
    const layout = assignLayout([
      c("m", "p", "q", "f"),
      c("a"),
      c("q"),
      c("b"),
      c("f"),
      c("p"),
    ]);
    const edgeToF = layout.branches.find(
      (b) => b.points[0]?.row === 0 && b.points[b.points.length - 1]?.row === 4,
    );
    expect(edgeToF).toBeDefined();
    const mid = edgeToF!.points.slice(1, -1); // rows 1..3
    // All intermediate points share one lane — no staircase drift.
    expect(new Set(mid.map((p) => p.lane)).size).toBe(1);
    // The lane change happens in the single final segment, onto f's dot.
    expect(edgeToF!.points[edgeToF!.points.length - 1].lane).toBe(layout.vertices[4].lane);
    expect(mid[0].lane).not.toBe(layout.vertices[4].lane);
    expectContinuous(layout);
  });

  it("tolerates parents outside the loaded page and empty input", () => {
    expect(assignLayout([])).toEqual({ vertices: [], branches: [], laneCount: 1 });
    const layout = assignLayout([c("tip", "not-loaded")]);
    expect(layout.vertices[0].lane).toBe(0);
    expectContinuous(layout);
  });

  it("survives 300 rows of randomized valid topology", () => {
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
    const layout = assignLayout(commits);
    expect(layout.vertices).toHaveLength(300);
    expectContinuous(layout);
    for (const v of layout.vertices) {
      expect(v.lane).toBeLessThan(layout.laneCount);
      expect(v.colorIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("branchPath", () => {
  it("merges straight runs into a single line command", () => {
    const path = branchPath(
      { colorIndex: 0, points: [{ lane: 0, row: 0 }, { lane: 0, row: 1 }, { lane: 0, row: 2 }] },
      14,
      28,
    );
    expect(path).toBe("M 7 14.0 L 7 70.0");
  });

  it("draws lane changes as vertical-tangent cubics", () => {
    const path = branchPath(
      { colorIndex: 0, points: [{ lane: 0, row: 0 }, { lane: 1, row: 1 }] },
      14,
      28,
    );
    // d = 0.8 * 28 = 22.4: control points offset purely vertically.
    expect(path).toBe("M 7 14.0 C 7 36.4 21 19.6 21 42.0");
  });

  it("palette has 12 entries", () => {
    expect(GRAPH_PALETTE).toHaveLength(12);
  });
});

describe("groupRefChips", () => {
  const d = (kind: string, name: string) => ({ kind, name });

  it("groups tracking remotes under their local branch", () => {
    const chips = groupRefChips([
      d("LocalBranch", "main"),
      d("RemoteBranch", "origin/main"),
      d("RemoteBranch", "upstream/main"),
      d("RemoteBranch", "origin/feature"),
      d("Tag", "v1.0.0"),
    ]);
    expect(chips.heads).toEqual([
      { name: "main", remotes: ["origin", "upstream"], active: false },
    ]);
    expect(chips.remotes).toEqual([{ name: "origin/feature", remote: "origin", branch: "feature" }]);
    expect(chips.tags).toEqual(["v1.0.0"]);
    expect(chips.isHead).toBe(false);
  });

  it("marks the checked-out branch active and sorts it first", () => {
    const chips = groupRefChips([
      d("Head", "HEAD"),
      d("LocalBranch", "dev"),
    ], "dev");
    expect(chips.isHead).toBe(true);
    expect(chips.heads[0]).toEqual({ name: "dev", remotes: [], active: true });
  });

  it("highlights only the checked-out branch when several sit on HEAD (#433)", () => {
    const chips = groupRefChips([
      d("Head", "HEAD"),
      d("LocalBranch", "main"),
      d("LocalBranch", "release"),
    ], "main");
    expect(chips.isHead).toBe(true);
    // Checked-out branch is active and sorts first; the co-located branch is a
    // normal chip.
    expect(chips.heads[0]).toEqual({ name: "main", remotes: [], active: true });
    expect(chips.heads.find((h) => h.name === "release")).toEqual({
      name: "release",
      remotes: [],
      active: false,
    });
    expect(chips.heads.filter((h) => h.active)).toHaveLength(1);
  });

  it("marks no branch active on a detached HEAD, even sitting on branches", () => {
    // headBranch = null (detached): the HEAD tint stays, but no chip is "current".
    const chips = groupRefChips([
      d("Head", "HEAD"),
      d("LocalBranch", "main"),
    ], null);
    expect(chips.isHead).toBe(true);
    expect(chips.heads.every((h) => !h.active)).toBe(true);
  });

  it("handles empty and remote-only decorations", () => {
    expect(groupRefChips([])).toEqual({ isHead: false, heads: [], remotes: [], tags: [] });
    const chips = groupRefChips([d("RemoteBranch", "origin/gh-pages")]);
    expect(chips.heads).toEqual([]);
    expect(chips.remotes).toEqual([
      { name: "origin/gh-pages", remote: "origin", branch: "gh-pages" },
    ]);
  });

  it("keeps remote/branch identity for tracking checkout, splitting slashed branch names (#432)", () => {
    const chips = groupRefChips([d("RemoteBranch", "origin/feat/nested/thing")]);
    expect(chips.remotes).toEqual([
      { name: "origin/feat/nested/thing", remote: "origin", branch: "feat/nested/thing" },
    ]);
  });
});

describe("baseUpdateMergeOids", () => {
  const refs = {
    featureTip: [{ kind: "LocalBranch", name: "feature" }],
    mainTip: [{ kind: "LocalBranch", name: "main" }],
  };
  const prs: OpenPrBaseLike[] = [{ number: 42, headRef: "feature", baseRef: "main" }];

  it("marks a merge that brings the open PR's base history into its first-parent chain", () => {
    const commits = [
      c("featureTip", "baseUpdate", "unrelatedMerge"),
      c("baseUpdate", "featureWork", "mainTip"),
      c("unrelatedMerge", "featureWork", "sideTip"),
      c("featureWork", "shared"),
      c("sideTip", "shared"),
      c("mainTip", "mainWork"),
      c("mainWork", "shared"),
      c("shared"),
    ];

    expect(baseUpdateMergeOids(commits, refs, prs)).toEqual(new Set(["baseUpdate"]));
  });

  it("leaves unrelated merges on the PR branch fully emphasized and lets users disable only base-update muting", () => {
    const commits = [
      c("featureTip", "baseUpdate", "unrelatedMerge"),
      c("baseUpdate", "featureWork", "mainTip"),
      c("unrelatedMerge", "featureWork", "sideTip"),
      c("featureWork", "shared"),
      c("sideTip", "shared"),
      c("mainTip", "mainWork"),
      c("mainWork", "shared"),
      c("shared"),
    ];
    const baseUpdates = baseUpdateMergeOids(commits, refs, prs);

    expect(shouldMuteBaseUpdateMerge("baseUpdate", baseUpdates, true)).toBe(true);
    expect(shouldMuteBaseUpdateMerge("unrelatedMerge", baseUpdates, true)).toBe(false);
    expect(shouldMuteBaseUpdateMerge("baseUpdate", baseUpdates, false)).toBe(false);
  });
});

describe("branchPath row expansion", () => {
  it("pushes rows below the expansion down by the extra height", () => {
    const line = { colorIndex: 0, points: [{ lane: 0, row: 0 }, { lane: 0, row: 1 }, { lane: 0, row: 2 }] };
    // No expansion: rows at y = 14, 42, 70 (rowHeight 28).
    expect(branchPath(line, 14, 28)).toBe("M 7 14.0 L 7 70.0");
    // Expansion of 100px after row 0: rows 1 and 2 shift down by 100.
    expect(branchPath(line, 14, 28, { afterRow: 0, extra: 100 })).toBe("M 7 14.0 L 7 170.0");
    // Expansion after the last row changes nothing.
    expect(branchPath(line, 14, 28, { afterRow: 2, extra: 100 })).toBe("M 7 14.0 L 7 70.0");
  });

  it("a stretched merge edge crosses out of the child dot in the FIRST row-height (#390)", () => {
    // Same geometry as below, but flagged as a merge edge: the long vertical
    // must run in the DESTINATION lane (the edge's own), not the child's —
    // the trunk also occupies the child's lane below its dot, and the edge's
    // color painted over it.
    const line = {
      colorIndex: 0,
      mergeEdge: true,
      points: [{ lane: 0, row: 0 }, { lane: 1, row: 1 }],
    };
    // Without expansion: unchanged single cubic.
    expect(branchPath(line, 14, 28)).toBe("M 7 14.0 C 7 36.4 21 19.6 21 42.0");
    // With 100px inserted after row 0: cross within the first row-height
    // (14 → 42), then vertical in lane 1 down to the destination (y = 142).
    expect(branchPath(line, 14, 28, { afterRow: 0, extra: 100 })).toBe(
      "M 7 14.0 C 7 36.4 21 19.6 21 42.0 L 21 142.0",
    );
  });

  it("marks non-first-parent edges as merge edges in the layout (#390)", () => {
    // m3 = merge of m2 (first parent) and f2: exactly one merge edge.
    const layout = assignLayout([c("m3", "m2", "f2"), c("f2", "base"), c("m2", "base"), c("base")]);
    const mergeEdges = layout.branches.filter((b) => b.mergeEdge);
    expect(mergeEdges).toHaveLength(1);
    // It's the m3→f2 edge: starts at row 0, ends at f2's row.
    expect(mergeEdges[0].points[0].row).toBe(0);
    expect(mergeEdges[0].points[mergeEdges[0].points.length - 1].row).toBe(1);
  });

  it("keeps a stretched lane change vertical and crosses only in the last row-height", () => {
    // The expansion (open commit details) lands inside the lane-change
    // segment: the line must run straight down the stretch and curve only
    // in the final row-height at the destination, not smear a diagonal
    // across the whole expanded block.
    const line = { colorIndex: 0, points: [{ lane: 0, row: 0 }, { lane: 1, row: 1 }] };
    // Without expansion: a single one-row cubic (d = 22.4).
    expect(branchPath(line, 14, 28)).toBe("M 7 14.0 C 7 36.4 21 19.6 21 42.0");
    // With 100px inserted after row 0: vertical to 100px above the
    // destination (y2 = 142), then the same one-row-height cubic.
    expect(branchPath(line, 14, 28, { afterRow: 0, extra: 100 })).toBe(
      "M 7 14.0 L 7 114.0 C 7 136.4 21 119.6 21 142.0",
    );
  });
});

describe("sliceBranchLine (#256, render windowing)", () => {
  const line = (rows: Array<[number, number]>) => ({
    colorIndex: 3,
    points: rows.map(([lane, row]) => ({ lane, row })),
  });

  it("returns null when the line lies entirely outside the window", async () => {
    const { sliceBranchLine } = await import("$lib/domain/git-graph");
    expect(sliceBranchLine(line([[0, 0], [0, 5]]), 10, 20)).toBeNull();
    expect(sliceBranchLine(line([[0, 30], [0, 40]]), 10, 20)).toBeNull();
    expect(sliceBranchLine(line([]), 0, 10)).toBeNull();
  });

  it("returns the line unchanged when fully inside the window", async () => {
    const { sliceBranchLine } = await import("$lib/domain/git-graph");
    const l = line([[0, 12], [1, 13], [1, 18]]);
    expect(sliceBranchLine(l, 10, 20)).toBe(l);
  });

  it("trims points outside the window but keeps the straddling endpoints", async () => {
    const { sliceBranchLine } = await import("$lib/domain/git-graph");
    const l = line([[0, 0], [0, 5], [1, 15], [1, 25], [1, 40]]);
    const sliced = sliceBranchLine(l, 10, 20)!;
    expect(sliced.points).toEqual([
      { lane: 0, row: 5 },
      { lane: 1, row: 15 },
      { lane: 1, row: 25 },
    ]);
    expect(sliced.colorIndex).toBe(3);
  });

  it("keeps a long straight segment that crosses the whole window", async () => {
    const { sliceBranchLine } = await import("$lib/domain/git-graph");
    const l = line([[2, 0], [2, 100]]);
    const sliced = sliceBranchLine(l, 40, 60)!;
    expect(sliced.points).toEqual([
      { lane: 2, row: 0 },
      { lane: 2, row: 100 },
    ]);
  });
});

describe("indexPrsByBranch (#448)", () => {
  const pr = (number: number, headRef: string): OpenPrLike => ({ number, headRef });

  it("returns an empty map for an empty list", () => {
    expect(indexPrsByBranch([])).toEqual(new Map());
  });

  it("indexes a single PR by its head branch", () => {
    const map = indexPrsByBranch([pr(7, "feature")]);
    expect(map.get("feature")).toEqual({ number: 7, headRef: "feature" });
    expect(map.size).toBe(1);
  });

  it("keeps the lowest PR number when several open PRs share a branch", () => {
    const map = indexPrsByBranch([pr(9, "feature"), pr(3, "feature"), pr(15, "feature")]);
    expect(map.get("feature")).toEqual({ number: 3, headRef: "feature" });
    expect(map.size).toBe(1);
  });

  it("keeps the lowest number regardless of input order", () => {
    const ascending = indexPrsByBranch([pr(1, "feature"), pr(5, "feature")]);
    const descending = indexPrsByBranch([pr(5, "feature"), pr(1, "feature")]);
    expect(ascending.get("feature")?.number).toBe(1);
    expect(descending.get("feature")?.number).toBe(1);
  });

  it("keeps unrelated branches separate", () => {
    const map = indexPrsByBranch([pr(7, "feature"), pr(12, "experiment")]);
    expect(map.size).toBe(2);
    expect(map.get("feature")?.number).toBe(7);
    expect(map.get("experiment")?.number).toBe(12);
  });
});

describe("prBadgePresentation (#459)", () => {
  const CI: CiStatus[] = ["success", "failure", "pending", null];
  const REVIEW: ReviewDecision[] = [
    "approved",
    "changes_requested",
    "review_required",
    null,
  ];

  it("maps each CI status to its color class", () => {
    expect(prBadgePresentation({ ciStatus: "success" }).ciClass).toBe("ci-success");
    expect(prBadgePresentation({ ciStatus: "failure" }).ciClass).toBe("ci-failure");
    expect(prBadgePresentation({ ciStatus: "pending" }).ciClass).toBe("ci-pending");
    expect(prBadgePresentation({ ciStatus: null }).ciClass).toBeNull();
    expect(prBadgePresentation({}).ciClass).toBeNull();
  });

  it("draft always suppresses the CI color class (grey styling wins)", () => {
    for (const ciStatus of CI) {
      expect(prBadgePresentation({ draft: true, ciStatus }).ciClass).toBeNull();
    }
  });

  it("maps review decision to its glyph", () => {
    expect(prBadgePresentation({ reviewDecision: "approved" }).reviewGlyph).toBe("✓");
    expect(prBadgePresentation({ reviewDecision: "changes_requested" }).reviewGlyph).toBe("±");
    // review_required and unknown carry no glyph (neutral).
    expect(prBadgePresentation({ reviewDecision: "review_required" }).reviewGlyph).toBeNull();
    expect(prBadgePresentation({ reviewDecision: null }).reviewGlyph).toBeNull();
    expect(prBadgePresentation({}).reviewGlyph).toBeNull();
  });

  it("shows the comment count only when positive", () => {
    expect(prBadgePresentation({ commentCount: 3 }).commentCount).toBe(3);
    expect(prBadgePresentation({ commentCount: 1 }).commentCount).toBe(1);
    expect(prBadgePresentation({ commentCount: 0 }).commentCount).toBeNull();
    expect(prBadgePresentation({ commentCount: null }).commentCount).toBeNull();
    expect(prBadgePresentation({}).commentCount).toBeNull();
  });

  it("is exhaustive and total over every CI × review × draft combination", () => {
    for (const draft of [false, true]) {
      for (const ciStatus of CI) {
        for (const reviewDecision of REVIEW) {
          const p = prBadgePresentation({ draft, ciStatus, reviewDecision });
          // ciClass: null unless a real status AND not a draft.
          const expectClass = !draft && ciStatus !== null;
          expect(p.ciClass === null).toBe(!expectClass);
          // Glyph never present for a review state without one.
          if (reviewDecision === "approved") expect(p.reviewGlyph).toBe("✓");
          else if (reviewDecision === "changes_requested") expect(p.reviewGlyph).toBe("±");
          else expect(p.reviewGlyph).toBeNull();
        }
      }
    }
  });
});

describe("PR detail labels (#459)", () => {
  it("labels each CI status, null when unknown", () => {
    expect(ciStatusLabel("success")).toBe("Checks passing");
    expect(ciStatusLabel("failure")).toBe("Checks failing");
    expect(ciStatusLabel("pending")).toBe("Checks pending");
    expect(ciStatusLabel(null)).toBeNull();
    expect(ciStatusLabel(undefined)).toBeNull();
  });

  it("labels each review decision, null when unknown", () => {
    expect(reviewDecisionLabel("approved")).toBe("Approved");
    expect(reviewDecisionLabel("changes_requested")).toBe("Changes requested");
    expect(reviewDecisionLabel("review_required")).toBe("Review required");
    expect(reviewDecisionLabel(null)).toBeNull();
    expect(reviewDecisionLabel(undefined)).toBeNull();
  });
});

describe("prDescription (#468)", () => {
  it("returns trimmed non-empty text", () => {
    expect(prDescription("  Hello world  ")).toBe("Hello world");
    expect(prDescription("multi\nline")).toBe("multi\nline");
  });

  it("collapses empty / whitespace-only / missing bodies to null", () => {
    expect(prDescription("")).toBeNull();
    expect(prDescription("   \n\t ")).toBeNull();
    expect(prDescription(null)).toBeNull();
    expect(prDescription(undefined)).toBeNull();
  });
});

describe("relativeTimeFrom (#468)", () => {
  const now = Date.parse("2024-06-15T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("reads 'now' under a minute and for future skew", () => {
    expect(relativeTimeFrom(ago(30 * SEC), now)).toBe("now");
    expect(relativeTimeFrom(ago(0), now)).toBe("now");
    // Future timestamp (clock skew) — never negative.
    expect(relativeTimeFrom(new Date(now + 5 * MIN).toISOString(), now)).toBe("now");
  });

  it("delegates valid timestamps to the compact relative formatter", () => {
    expect(relativeTimeFrom(ago(5 * DAY), now)).toBe("5d");
  });

  it("returns null for missing or unparseable timestamps", () => {
    expect(relativeTimeFrom(null, now)).toBeNull();
    expect(relativeTimeFrom(undefined, now)).toBeNull();
    expect(relativeTimeFrom("not a date", now)).toBeNull();
  });
});

describe("prDetailComments (#468)", () => {
  const now = Date.parse("2024-06-15T12:00:00Z");

  it("maps author, relative time and trimmed body", () => {
    const out = prDetailComments(
      [
        {
          author: "alice",
          createdAt: new Date(now - 2 * 60 * 1000).toISOString(),
          body: "  looks good  ",
        },
      ],
      now,
    );
    expect(out).toEqual([
      { author: "alice", time: "2m", body: "looks good" },
    ]);
  });

  it("falls back to '(unknown)' for a deleted author", () => {
    const out = prDetailComments(
      [{ author: null, createdAt: new Date(now).toISOString(), body: "ghost" }],
      now,
    );
    expect(out[0].author).toBe("(unknown)");
  });

  it("drops comments whose body is empty after trimming", () => {
    const out = prDetailComments(
      [
        { author: "a", createdAt: new Date(now).toISOString(), body: "   " },
        { author: "b", createdAt: new Date(now).toISOString(), body: "real" },
      ],
      now,
    );
    expect(out.map((c) => c.body)).toEqual(["real"]);
  });

  it("returns [] for null / undefined / empty input", () => {
    expect(prDetailComments(null, now)).toEqual([]);
    expect(prDetailComments(undefined, now)).toEqual([]);
    expect(prDetailComments([], now)).toEqual([]);
  });

  it("keeps time null when a comment timestamp is unparseable", () => {
    const out = prDetailComments(
      [{ author: "a", createdAt: "garbage", body: "hi" }],
      now,
    );
    expect(out[0].time).toBeNull();
  });
});
