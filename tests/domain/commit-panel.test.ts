import { describe, it, expect } from "vitest";
import {
  buildStageFiles,
  groupStageFiles,
  stagedCountOf,
  conflictCountOf,
  unstagedPaths,
  stagedPaths,
  canCommit,
  commitButtonLabel,
  initialCommitPanelState,
  setMessage,
  startCommit,
  commitSucceeded,
  commitFailed,
  type StatusBucketsLike,
} from "../../src/lib/domain/commit-panel";

function buckets(partial: Partial<StatusBucketsLike>): StatusBucketsLike {
  return {
    staged: partial.staged ?? [],
    changes: partial.changes ?? [],
    merge: partial.merge ?? [],
    untracked: partial.untracked ?? [],
  };
}

describe("buildStageFiles", () => {
  it("orders merge, then staged, then unstaged, then untracked", () => {
    const files = buildStageFiles(
      buckets({
        merge: [{ path: "conflict.ts", status: "Conflicted" }],
        staged: [{ path: "a.ts", status: "Modified" }],
        changes: [{ path: "b.ts", status: "Modified" }],
        untracked: [{ path: "c.ts", status: "Untracked" }],
      }),
    );
    expect(files.map((f) => f.section)).toEqual([
      "merge",
      "staged",
      "unstaged",
      "untracked",
    ]);
  });

  it("resolves status codes to porcelain letters", () => {
    const files = buildStageFiles(buckets({ staged: [{ path: "a.ts", status: "Added" }] }));
    expect(files[0].status).toBe("A");
  });

  it("flags only the staged section as staged", () => {
    const files = buildStageFiles(
      buckets({
        staged: [{ path: "a.ts", status: "Modified" }],
        changes: [{ path: "b.ts", status: "Modified" }],
        untracked: [{ path: "c.ts", status: "Untracked" }],
      }),
    );
    expect(files.find((f) => f.path === "a.ts")?.staged).toBe(true);
    expect(files.find((f) => f.path === "b.ts")?.staged).toBe(false);
    expect(files.find((f) => f.path === "c.ts")?.staged).toBe(false);
  });

  it("emits a partially-staged file twice: once staged, once unstaged", () => {
    // The classic case: staged edits PLUS further working-tree edits — the
    // backend lists the path in both buckets.
    const files = buildStageFiles(
      buckets({
        staged: [{ path: "partial.ts", status: "Modified" }],
        changes: [{ path: "partial.ts", status: "Modified" }],
      }),
    );
    const rows = files.filter((f) => f.path === "partial.ts");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.staged).sort()).toEqual([false, true]);
    expect(stagedCountOf(files)).toBe(1);
  });

  it("returns an empty list for a clean tree", () => {
    expect(buildStageFiles(buckets({}))).toEqual([]);
  });
});

describe("groupStageFiles", () => {
  it("labels sections and omits empty ones", () => {
    const files = buildStageFiles(
      buckets({
        staged: [{ path: "a.ts", status: "Modified" }],
        changes: [{ path: "b.ts", status: "Modified" }],
      }),
    );
    const groups = groupStageFiles(files);
    expect(groups.map((g) => g.section)).toEqual(["staged", "unstaged"]);
    expect(groups[0].label).toBe("Staged Changes");
    expect(groups[1].label).toBe("Changes");
  });

  it("returns no groups for an empty file list", () => {
    expect(groupStageFiles([])).toEqual([]);
  });
});

describe("counts and path derivations", () => {
  const files = buildStageFiles(
    buckets({
      merge: [{ path: "m.ts", status: "Conflicted" }],
      staged: [{ path: "s.ts", status: "Modified" }],
      changes: [{ path: "c.ts", status: "Modified" }],
      untracked: [{ path: "u.ts", status: "Untracked" }],
    }),
  );

  it("counts staged and conflicted files", () => {
    expect(stagedCountOf(files)).toBe(1);
    expect(conflictCountOf(files)).toBe(1);
  });

  it("stage-all candidates exclude the staged section and de-dupe", () => {
    // merge + changes + untracked are stageable; merge is not "staged".
    expect(unstagedPaths(files).sort()).toEqual(["c.ts", "m.ts", "u.ts"]);
  });

  it("unstage-all candidates are exactly the staged section", () => {
    expect(stagedPaths(files)).toEqual(["s.ts"]);
  });

  it("de-dupes a partially-staged path in stage-all candidates", () => {
    const partial = buildStageFiles(
      buckets({
        staged: [{ path: "p.ts", status: "Modified" }],
        changes: [{ path: "p.ts", status: "Modified" }],
      }),
    );
    expect(unstagedPaths(partial)).toEqual(["p.ts"]);
  });
});

describe("canCommit", () => {
  it("is true with a message, staged files, and no conflicts", () => {
    expect(canCommit({ message: "fix", stagedCount: 1, conflictCount: 0 })).toBe(true);
  });

  it("is false for an empty message", () => {
    expect(canCommit({ message: "", stagedCount: 2, conflictCount: 0 })).toBe(false);
  });

  it("is false for a whitespace-only message", () => {
    expect(canCommit({ message: "   \n\t ", stagedCount: 2, conflictCount: 0 })).toBe(false);
  });

  it("is false with nothing staged", () => {
    expect(canCommit({ message: "fix", stagedCount: 0, conflictCount: 0 })).toBe(false);
  });

  it("is false while conflicts remain", () => {
    expect(canCommit({ message: "fix", stagedCount: 1, conflictCount: 1 })).toBe(false);
  });
});

describe("commitButtonLabel", () => {
  it("surfaces the staged count", () => {
    expect(commitButtonLabel(3)).toBe("Commit (3)");
  });

  it("omits the count when nothing is staged", () => {
    expect(commitButtonLabel(0)).toBe("Commit");
  });
});

describe("commit-panel state machine", () => {
  it("starts idle with an empty draft and no error", () => {
    expect(initialCommitPanelState()).toEqual({ message: "", phase: "idle", error: null });
  });

  it("setMessage updates the draft", () => {
    const s = setMessage(initialCommitPanelState(), "hello");
    expect(s.message).toBe("hello");
  });

  it("setMessage clears a stale error once non-whitespace is typed", () => {
    const failed = commitFailed(initialCommitPanelState(), "boom");
    const typed = setMessage(failed, "fix");
    expect(typed.error).toBeNull();
  });

  it("setMessage keeps the error while the message stays blank", () => {
    const failed = commitFailed(initialCommitPanelState(), "boom");
    const cleared = setMessage(failed, "   ");
    expect(cleared.error).toBe("boom");
  });

  it("startCommit moves idle → committing and clears any prior error", () => {
    const failed = commitFailed(setMessage(initialCommitPanelState(), "fix"), "boom");
    const started = startCommit(failed);
    expect(started.phase).toBe("committing");
    expect(started.error).toBeNull();
    expect(started.message).toBe("fix");
  });

  it("startCommit is a no-op while already committing (guards double submit)", () => {
    const committing = startCommit(setMessage(initialCommitPanelState(), "fix"));
    expect(startCommit(committing)).toBe(committing);
  });

  it("commitSucceeded clears the draft and returns to idle", () => {
    const committing = startCommit(setMessage(initialCommitPanelState(), "fix"));
    const done = commitSucceeded(committing);
    expect(done).toEqual({ message: "", phase: "idle", error: null });
  });

  it("commitFailed preserves the message, surfaces the error, returns idle", () => {
    const committing = startCommit(setMessage(initialCommitPanelState(), "keep me"));
    const failed = commitFailed(committing, "commit rejected");
    expect(failed.phase).toBe("idle");
    expect(failed.message).toBe("keep me");
    expect(failed.error).toBe("commit rejected");
  });

  it("transitions never mutate the input state (immutability)", () => {
    const s0 = initialCommitPanelState();
    setMessage(s0, "x");
    startCommit(s0);
    commitFailed(s0, "e");
    expect(s0).toEqual({ message: "", phase: "idle", error: null });
  });
});
