/**
 * SCM merge-conflict / in-progress operation handling (#294).
 *
 * Behavior under test (contracts, not internals):
 * - a commit is refused while unresolved merge entries exist, and gitCommit is
 *   never invoked;
 * - once the conflict is staged (merge empty), a commit goes through;
 * - abortOperation dispatches to the backend command matching op_state and
 *   then refreshes the summary;
 * - continueRebase calls the rebase-continue backend and refreshes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitStatusSummary, GitOpState } from "$lib/api/git";

const gitRepoRootMock = vi.fn((_path: string) => Promise.resolve({ ok: true, data: "/repo" }));
const gitSummaryMock = vi.fn(
  (_root: string): Promise<{ ok: boolean; data?: GitStatusSummary }> =>
    Promise.resolve({ ok: true }),
);
const gitCommitMock = vi.fn(
  (_root: string, _msg: string, _opts: unknown) =>
    Promise.resolve({ ok: true, data: { commit_id: "abc", summary: "s" } }),
);
const gitMergeAbortMock = vi.fn((_root: string) => Promise.resolve({ ok: true }));
const gitRebaseAbortMock = vi.fn((_root: string) => Promise.resolve({ ok: true }));
const gitRebaseContinueMock = vi.fn((_root: string) => Promise.resolve({ ok: true }));
const gitCherryPickAbortMock = vi.fn((_root: string) => Promise.resolve({ ok: true }));
const gitRevertAbortMock = vi.fn((_root: string) => Promise.resolve({ ok: true }));

vi.mock("$lib/api/git", () => ({
  gitRepoRoot: (path: string) => gitRepoRootMock(path),
  gitSummary: (root: string) => gitSummaryMock(root),
  gitStage: vi.fn(async () => ({ ok: true })),
  gitUnstage: vi.fn(async () => ({ ok: true })),
  gitDiscard: vi.fn(async () => ({ ok: true })),
  gitCommit: (root: string, msg: string, opts: unknown) => gitCommitMock(root, msg, opts),
  gitWatchRepo: vi.fn(async () => {}),
  gitUnwatchRepo: vi.fn(async () => {}),
  gitMergeAbort: (root: string) => gitMergeAbortMock(root),
  gitRebaseAbort: (root: string) => gitRebaseAbortMock(root),
  gitRebaseContinue: (root: string) => gitRebaseContinueMock(root),
  gitCherryPickAbort: (root: string) => gitCherryPickAbortMock(root),
  gitRevertAbort: (root: string) => gitRevertAbortMock(root),
}));

vi.mock("$lib/state/git-refresh", () => ({
  subscribeGitChanges: vi.fn(async () => {}),
  notifyLocalGitChange: vi.fn(),
}));

function summary(over: Partial<GitStatusSummary> = {}): GitStatusSummary {
  return {
    is_repo: true,
    repo_root: "/repo",
    branch: "main",
    detached: false,
    staged: [],
    changes: [],
    untracked: [],
    merge: [],
    op_state: "clean",
    ...over,
  };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Fresh store activated on a repo whose summary is `s`. */
async function storeWith(s: GitStatusSummary) {
  vi.resetModules();
  gitRepoRootMock.mockResolvedValue({ ok: true, data: "/repo" });
  gitSummaryMock.mockResolvedValue({ ok: true, data: s });
  const mod = await import("$lib/state/scm.svelte");
  const store = mod.getScmStore("test-pane");
  await store.setActivePath("/repo");
  await flushMicrotasks();
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scmStore commit guard with conflicts", () => {
  it("refuses to commit while an unresolved conflict remains", async () => {
    const store = await storeWith(
      summary({
        op_state: "merge",
        merge: [{ path: "src/x.ts", old_path: null, status: "Conflicted" }],
        staged: [{ path: "src/y.ts", old_path: null, status: "Modified" }],
      }),
    );
    store.setCommitMessage("resolve");

    const r = await store.commit();

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/conflicted file/i);
    // The backend commit is never attempted while conflicts remain.
    expect(gitCommitMock).not.toHaveBeenCalled();
  });

  it("commits once the conflict has been staged (merge empty)", async () => {
    const store = await storeWith(
      summary({
        // op_state still merge, but conflict resolved (staged) → committable.
        op_state: "merge",
        merge: [],
        staged: [{ path: "src/x.ts", old_path: null, status: "Modified" }],
      }),
    );
    store.setCommitMessage("resolve merge");

    const r = await store.commit();

    expect(r.ok).toBe(true);
    expect(gitCommitMock).toHaveBeenCalledWith("/repo", "resolve merge", { amend: false });
  });
});

describe("scmStore.abortOperation", () => {
  const cases: Array<[GitOpState, () => ReturnType<typeof vi.fn>]> = [
    ["merge", () => gitMergeAbortMock],
    ["rebase", () => gitRebaseAbortMock],
    ["cherry_pick", () => gitCherryPickAbortMock],
    ["revert", () => gitRevertAbortMock],
  ];

  for (const [op, getMock] of cases) {
    it(`dispatches the ${op} abort command and refreshes`, async () => {
      const store = await storeWith(
        summary({
          op_state: op,
          merge: [{ path: "src/x.ts", old_path: null, status: "Conflicted" }],
        }),
      );
      // After abort the backend reports a clean tree.
      gitSummaryMock.mockResolvedValue({ ok: true, data: summary() });

      const r = await store.abortOperation();

      expect(r.ok).toBe(true);
      expect(getMock()).toHaveBeenCalledWith("/repo");
      // A refresh re-fetched the (now clean) summary.
      await flushMicrotasks();
      expect(store.summary.op_state).toBe("clean");
    });
  }

  it("is a no-op on a clean repo", async () => {
    const store = await storeWith(summary());
    const r = await store.abortOperation();
    expect(r.ok).toBe(true);
    expect(gitMergeAbortMock).not.toHaveBeenCalled();
  });
});

describe("scmStore.continueRebase", () => {
  it("calls the rebase-continue backend and refreshes", async () => {
    const store = await storeWith(summary({ op_state: "rebase", merge: [] }));
    gitSummaryMock.mockResolvedValue({ ok: true, data: summary() });

    const r = await store.continueRebase();

    expect(r.ok).toBe(true);
    expect(gitRebaseContinueMock).toHaveBeenCalledWith("/repo");
    await flushMicrotasks();
    expect(store.summary.op_state).toBe("clean");
  });
});
