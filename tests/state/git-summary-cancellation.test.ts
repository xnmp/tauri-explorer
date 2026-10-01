/**
 * Observable cancellation contract for shared SCM status scans (#426).
 *
 * Each pane is a consumer of the shared per-repository request. Releasing one
 * pane cannot cancel another pane's scan; releasing the last consumer can.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSummary } from "$lib/api/git";

const gitSummaryMock = vi.fn();
const cancelGitStatusMock = vi.fn(async (_taskId: number) => {});

vi.mock("$lib/api/git", () => ({
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

function summary(marker?: string): { ok: true; data: GitStatusSummary } {
  return {
    ok: true,
    data: {
      is_repo: true,
      repo_root: "/repo",
      branch: "main",
      detached: false,
      staged: marker
        ? [{ path: marker, status: "Added", old_path: null }]
        : [],
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

  it("does not let an older passive scan overwrite a newer forced result", async () => {
    const passiveResponse = deferred<ReturnType<typeof summary>>();
    const forcedResponse = deferred<ReturnType<typeof summary>>();
    gitSummaryMock
      .mockReturnValueOnce(passiveResponse.promise)
      .mockReturnValueOnce(forcedResponse.promise);
    const cache = await import("$lib/state/git-summary-cache");

    const passive = cache.fetchGitSummary("/repo");
    const forced = cache.fetchGitSummary("/repo", { force: true });

    forcedResponse.resolve(summary("POST-MUTATION"));
    await forced;
    passiveResponse.resolve(summary("PRE-MUTATION"));
    await passive;

    const cached = await cache.fetchGitSummary("/repo");
    expect(gitSummaryMock).toHaveBeenCalledTimes(2);
    expect(cached.ok && cached.data.staged[0].path).toBe("POST-MUTATION");
  });
});
