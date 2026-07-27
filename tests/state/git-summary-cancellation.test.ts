/**
 * Observable cancellation contract for shared SCM status scans (#426).
 *
 * Each pane is a consumer of the shared per-repository request. Releasing one
 * pane cannot cancel another pane's scan; releasing the last consumer can.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSummary } from "$lib/api/files";

const gitSummaryMock = vi.fn();
const cancelGitStatusMock = vi.fn(async (_taskId: number) => {});

vi.mock("$lib/api/files", () => ({
  gitSummary: (root: string, taskId: number) => gitSummaryMock(root, taskId),
  cancelGitStatus: (taskId: number) => cancelGitStatusMock(taskId),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function summary(): { ok: true; data: GitStatusSummary } {
  return {
    ok: true,
    data: {
      is_repo: true,
      repo_root: "/repo",
      branch: "main",
      detached: false,
      staged: [],
      changes: [],
      untracked: [],
      merge: [],
      op_state: "clean",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("shared SCM status ownership", () => {
  it("cancels only when no pane still consumes the in-flight repository scan", async () => {
    const response = deferred<ReturnType<typeof summary>>();
    gitSummaryMock.mockReturnValue(response.promise);
    const cache = await import("$lib/state/git-summary-cache");

    const first = cache.fetchGitSummary("/repo", { consumerId: "pane-a" });
    const second = cache.fetchGitSummary("/repo", { consumerId: "pane-b" });

    expect(gitSummaryMock).toHaveBeenCalledTimes(1);
    const taskId = gitSummaryMock.mock.calls[0][1];
    expect(taskId).toEqual(expect.any(Number));

    cache.releaseGitSummaryConsumer("pane-a");
    expect(cancelGitStatusMock).not.toHaveBeenCalled();

    cache.releaseGitSummaryConsumer("pane-b");
    expect(cancelGitStatusMock).toHaveBeenCalledOnce();
    expect(cancelGitStatusMock).toHaveBeenCalledWith(taskId);

    response.resolve(summary());
    await Promise.all([first, second]);
  });
});
