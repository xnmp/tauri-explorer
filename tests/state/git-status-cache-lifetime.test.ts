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

describe("gitStatusStore recently visited cache", () => {
  it("keeps settled badges while untracked and revalidates them on return", async () => {
    getGitStatusMock.mockResolvedValueOnce({
      ok: true,
      data: { is_git_repo: true, statuses: { "a.ts": "Modified" } },
    });

    const release = gitStatusStore.trackDirectory("/repo");
    await gitStatusStore.fetchForDirectory("/repo");
    release();

    expect(gitStatusStore.getStatus("/repo", "a.ts")).toBe("Modified");

    await gitStatusStore.refresh();
    expect(getGitStatusMock).toHaveBeenCalledOnce();

    const refreshed = deferred<{
      ok: true;
      data: { is_git_repo: true; statuses: { "a.ts": "Added" } };
    }>();
    getGitStatusMock.mockReturnValueOnce(refreshed.promise);

    gitStatusStore.trackDirectory("/repo");

    expect(gitStatusStore.getStatus("/repo", "a.ts")).toBe("Modified");
    expect(gitStatusStore.isDirLoading("/repo")).toBe(true);
    expect(getGitStatusMock).toHaveBeenCalledTimes(2);

    refreshed.resolve({
      ok: true,
      data: { is_git_repo: true, statuses: { "a.ts": "Added" } },
    });
    await gitStatusStore.fetchForDirectory("/repo");

    expect(gitStatusStore.getStatus("/repo", "a.ts")).toBe("Added");
  });
});
