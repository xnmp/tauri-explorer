/**
 * Observable cancellation contract for per-directory badge scans (#426).
 *
 * A scan is shared by panes showing the same directory. Navigating one pane
 * away must keep that scan alive; navigating the final pane away must cancel
 * the backend request and must not publish a late result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getGitStatusMock = vi.fn();
const cancelGetGitStatusMock = vi.fn(async (_taskId: number) => {});

vi.mock("$lib/api/files", () => ({
  getGitStatus: (path: string, taskId: number) => getGitStatusMock(path, taskId),
  cancelGetGitStatus: (taskId: number) => cancelGetGitStatusMock(taskId),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { gitStatusStore } from "$lib/state/git-status.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  gitStatusStore.clear();
});

describe("gitStatusStore pane ownership", () => {
  it("cancels a shared scan only after the final pane leaves its directory", async () => {
    const response = deferred<{
      ok: true;
      data: { is_git_repo: true; statuses: { "late.ts": "Modified" } };
    }>();
    getGitStatusMock.mockReturnValue(response.promise);

    const releaseFirst = gitStatusStore.trackDirectory("/repo");
    const releaseSecond = gitStatusStore.trackDirectory("/repo");
    const fetch = gitStatusStore.fetchForDirectory("/repo");

    expect(getGitStatusMock).toHaveBeenCalledTimes(1);
    expect(gitStatusStore.isDirLoading("/repo")).toBe(true);
    const taskId = getGitStatusMock.mock.calls[0][1];
    expect(taskId).toEqual(expect.any(Number));

    releaseFirst();
    expect(cancelGetGitStatusMock).not.toHaveBeenCalled();

    releaseSecond();
    expect(cancelGetGitStatusMock).toHaveBeenCalledOnce();
    expect(cancelGetGitStatusMock).toHaveBeenCalledWith(taskId);

    response.resolve({
      ok: true,
      data: { is_git_repo: true, statuses: { "late.ts": "Modified" } },
    });
    await fetch;

    expect(gitStatusStore.isDirLoading("/repo")).toBe(false);
    expect(gitStatusStore.getStatus("/repo", "late.ts")).toBeNull();
  });
});
