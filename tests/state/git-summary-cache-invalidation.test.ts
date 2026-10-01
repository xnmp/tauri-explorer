import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSummary } from "$lib/api/git";

const api = vi.hoisted(() => ({ summary: vi.fn(), cancel: vi.fn() }));

vi.mock("$lib/api/git", () => ({
  gitSummary: (root: string, taskId: number) => api.summary(root, taskId),
  cancelGitStatus: (taskId: number) => api.cancel(taskId),
}));

function result(marker: string): { ok: true; data: GitStatusSummary } {
  return {
    ok: true,
    data: {
      is_repo: true,
      repo_root: "/repo",
      branch: "main",
      detached: false,
      staged: [{ path: marker, status: "Added", old_path: null }],
      changes: [],
      untracked: [],
      merge: [],
      op_state: "clean",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function productionModules() {
  const cache = await import("$lib/state/git-summary-cache");
  const changes = await import("$lib/state/git-refresh");
  return { ...cache, ...changes };
}

beforeEach(() => {
  vi.resetModules();
  api.summary.mockReset();
  api.cancel.mockReset();
});

describe("git summary cache change boundaries", () => {
  it.each([
    ["local", (changes: Awaited<ReturnType<typeof productionModules>>) => changes.notifyLocalGitChange("/repo")],
    ["watcher", (changes: Awaited<ReturnType<typeof productionModules>>) => changes.emitWatcherGitChange("/repo")],
  ])("%s changes invalidate a settled summary", async (_source, announce) => {
    api.summary.mockResolvedValueOnce(result("before")).mockResolvedValueOnce(result("after"));
    const modules = await productionModules();
    expect((await modules.fetchGitSummary("/repo")).ok).toBe(true);

    announce(modules);
    const refreshed = await modules.fetchGitSummary("/repo");

    expect(api.summary).toHaveBeenCalledTimes(2);
    expect(refreshed.ok && refreshed.data.staged[0].path).toBe("after");
  });

  it.each([false, true])("a change detaches a pending %s scan from its replacement", async (force) => {
    const before = deferred<ReturnType<typeof result>>();
    const after = deferred<ReturnType<typeof result>>();
    api.summary.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    const modules = await productionModules();
    const oldRequest = modules.fetchGitSummary("/repo", { force });
    await Promise.resolve();

    modules.emitWatcherGitChange("/repo");
    const newRequest = modules.fetchGitSummary("/repo", { force });
    await Promise.resolve();
    expect(api.summary).toHaveBeenCalledTimes(2);

    after.resolve(result("after"));
    expect((await newRequest).ok).toBe(true);
    before.resolve(result("before"));
    await oldRequest;

    const cached = await modules.fetchGitSummary("/repo");
    expect(api.summary).toHaveBeenCalledTimes(2);
    expect(cached.ok && cached.data.staged[0].path).toBe("after");
  });

  it("retries after a failed scan instead of caching the failure", async () => {
    api.summary
      .mockResolvedValueOnce({ ok: false, error: "offline" })
      .mockResolvedValueOnce(result("recovered"));
    const { fetchGitSummary } = await productionModules();

    expect((await fetchGitSummary("/repo")).ok).toBe(false);
    const retried = await fetchGitSummary("/repo");

    expect(api.summary).toHaveBeenCalledTimes(2);
    expect(retried.ok && retried.data.staged[0].path).toBe("recovered");
  });

  it("bounds settled summaries to 64 least-recently-used repositories", async () => {
    api.summary.mockImplementation(async (root: string) => result(root));
    const { fetchGitSummary } = await productionModules();
    for (let index = 0; index < 65; index++) await fetchGitSummary(`/repo-${index}`);

    await fetchGitSummary("/repo-0");

    expect(api.summary).toHaveBeenCalledTimes(66);
  });
});
