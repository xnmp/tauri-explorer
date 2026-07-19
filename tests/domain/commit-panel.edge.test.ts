import { describe, it, expect } from "vitest";
import {
  buildStageFiles,
  groupStageFiles,
  stagedCountOf,
  conflictCountOf,
  unstagedPaths,
  stagedPaths,
  type StatusBucketsLike,
} from "../../src/lib/domain/commit-panel";

function buckets(p: Partial<StatusBucketsLike>): StatusBucketsLike {
  return { staged: p.staged ?? [], changes: p.changes ?? [], merge: p.merge ?? [], untracked: p.untracked ?? [] };
}

describe("edge: same path in all buckets", () => {
  const files = buildStageFiles(
    buckets({
      merge: [{ path: "x", status: "Conflicted" }],
      staged: [{ path: "x", status: "Modified" }],
      changes: [{ path: "x", status: "Modified" }],
      untracked: [{ path: "x", status: "Untracked" }],
    }),
  );
  it("keeps one row per bucket (4 rows)", () => {
    expect(files).toHaveLength(4);
  });
  it("stagedCount counts only the staged bucket instance", () => {
    expect(stagedCountOf(files)).toBe(1);
    expect(conflictCountOf(files)).toBe(1);
  });
  it("unstagedPaths de-dupes across merge/changes/untracked to a single path", () => {
    expect(unstagedPaths(files)).toEqual(["x"]);
  });
  it("stagedPaths returns the single staged instance", () => {
    expect(stagedPaths(files)).toEqual(["x"]);
  });
  it("grouping preserves all four sections", () => {
    expect(groupStageFiles(files).map((g) => g.section)).toEqual([
      "merge",
      "staged",
      "unstaged",
      "untracked",
    ]);
  });
});

describe("edge: renames and weird paths", () => {
  it("keeps rename status letter R and does not split the arrow path", () => {
    const files = buildStageFiles(buckets({ staged: [{ path: "old -> new", status: "Renamed" }] }));
    expect(files[0].status).toBe("R");
    expect(files[0].path).toBe("old -> new");
    expect(stagedPaths(files)).toEqual(["old -> new"]);
  });
  it("handles empty-string and duplicate-empty paths without collapsing distinct rows wrongly", () => {
    const files = buildStageFiles(
      buckets({ changes: [{ path: "", status: "Modified" }, { path: "", status: "Modified" }] }),
    );
    expect(files).toHaveLength(2);
    // de-dup collapses the two empty paths to one candidate
    expect(unstagedPaths(files)).toEqual([""]);
  });
  it("handles unicode / spaces / very long paths", () => {
    const long = "a/".repeat(500) + "файл 名前.txt";
    const files = buildStageFiles(buckets({ untracked: [{ path: long, status: "Untracked" }] }));
    expect(files[0].path).toBe(long);
    expect(files[0].status).toBe("U");
  });
  it("unknown status codes fall through gitStatusLetter without throwing", () => {
    const files = buildStageFiles(buckets({ staged: [{ path: "p", status: "Bogus" }] }));
    expect(typeof files[0].status).toBe("string");
  });
});

describe("edge: partial-stage coherence after a simulated stage", () => {
  it("count drops by one when the working-tree side of a partial file is staged", () => {
    // Before: p is in both staged and changes (partial).
    const before = buildStageFiles(buckets({ staged: [{ path: "p", status: "Modified" }], changes: [{ path: "p", status: "Modified" }] }));
    // The graph-level workingChanges count sums all bucket lengths.
    const totalBefore = before.length; // 2 (double-counted)
    // After staging p's working-tree side, backend reports only staged.
    const after = buildStageFiles(buckets({ staged: [{ path: "p", status: "Modified" }] }));
    const totalAfter = after.length; // 1
    expect(totalBefore).toBe(2);
    expect(totalAfter).toBe(1);
    // The domain list is coherent. GitGraphView.workingChanges sums bucket
    // lengths (so it double-counts a partial file); the component now calls
    // reload() after every stage/unstage (afterStageChange) to recompute it
    // from the canonical summary, so the header can't go stale by one (#466).
  });
});
