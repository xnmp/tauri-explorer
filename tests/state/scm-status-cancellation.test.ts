/**
 * Store-level race coverage for same-repository navigation during an SCM scan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSummary } from "$lib/api/git";

const gitRepoRootMock = vi.fn();
const gitSummaryMock = vi.fn();
const cancelGitStatusMock = vi.fn(async (_taskId: number) => {});

vi.mock("$lib/api/git", () => ({
  gitRepoRoot: (path: string) => gitRepoRootMock(path),
  gitSummary: (root: string, taskId: number) => gitSummaryMock(root, taskId),
  cancelGitStatus: (taskId: number) => cancelGitStatusMock(taskId),
  gitStage: vi.fn(async () => ({ ok: true })),
  gitUnstage: vi.fn(async () => ({ ok: true })),
  gitDiscard: vi.fn(async () => ({ ok: true })),
  gitCommit: vi.fn(async () => ({ ok: true })),
  gitWatchRepo: vi.fn(async () => {}),
  gitUnwatchRepo: vi.fn(async () => {}),
}));
vi.mock("$lib/state/git-refresh", () => ({
  subscribeGitChanges: vi.fn(async () => () => {}),
  notifyLocalGitChange: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function summary(marker: string): { ok: true; data: GitStatusSummary } {
  return {
    ok: true,
    data: {
      is_repo: true,
      repo_root: "/repo",
      branch: "main",
      detached: false,
      staged: [],
      changes: [{ path: marker, status: "Modified", old_path: null }],
      untracked: [],
      merge: [],
      op_state: "clean",
    },
  };
}

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  gitRepoRootMock.mockResolvedValue({ ok: true, data: "/repo" });
});

describe("SCM same-repository navigation", () => {
  it("restarts a cancelled summary and ignores the old path's late result", async () => {
    const oldResponse = deferred<ReturnType<typeof summary>>();
    gitSummaryMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(summary("new.ts"));
    const { getScmStore } = await import("$lib/state/scm.svelte");
    const store = getScmStore("pane-race");

    const oldActivation = store.setActivePath("/repo/old");
    await flush();
    expect(store.pending).toBe(true);

    await store.setActivePath("/repo/new");

    expect(cancelGitStatusMock).toHaveBeenCalledOnce();
    expect(gitSummaryMock).toHaveBeenCalledTimes(2);
    expect(store.summary.changes.map((entry) => entry.path)).toEqual(["new.ts"]);
    expect(store.pending).toBe(false);

    oldResponse.resolve(summary("old.ts"));
    await oldActivation;
    expect(store.summary.changes.map((entry) => entry.path)).toEqual(["new.ts"]);
  });
});
