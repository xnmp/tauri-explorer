/**
 * SCM summary cache warming (#287).
 *
 * `scmStore.warm(path)` populates the summary cache for the repo containing
 * `path` WITHOUT mounting the panel, so the panel's first open serves a cached
 * summary. Behavior under test:
 * - a warm caches the repo's summary, which a subsequent activation then
 *   serves immediately (no fetch on activation);
 * - a non-repo path caches nothing;
 * - a second warm of an already-cached repo does not re-fetch;
 * - a failing probe/summary is swallowed (best-effort);
 * - warming never starts the repo watcher (single-watcher invariant preserved).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitStatusSummary } from "$lib/api/files";

const gitRepoRootMock = vi.fn();
const gitSummaryMock = vi.fn();
const gitWatchRepoMock = vi.fn(async (_root: string) => {});

vi.mock("$lib/api/files", () => ({
  gitRepoRoot: (path: string) => gitRepoRootMock(path),
  gitSummary: (root: string) => gitSummaryMock(root),
  gitStage: vi.fn(async () => ({ ok: true })),
  gitUnstage: vi.fn(async () => ({ ok: true })),
  gitDiscard: vi.fn(async () => ({ ok: true })),
  gitCommit: vi.fn(async () => ({ ok: true })),
  gitWatchRepo: (root: string) => gitWatchRepoMock(root),
  gitUnwatchRepo: vi.fn(async () => {}),
}));

vi.mock("$lib/state/git-refresh", () => ({
  subscribeGitChanges: vi.fn(async () => {}),
  notifyLocalGitChange: vi.fn(),
}));

function makeSummary(root: string, changedPath: string): GitStatusSummary {
  return {
    is_repo: true,
    repo_root: root,
    branch: "main",
    detached: false,
    staged: [],
    changes: [{ path: changedPath, status: "Modified", old_path: null }],
    untracked: [],
    merge: [],
  };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function freshStore() {
  vi.resetModules();
  const mod = await import("$lib/state/scm.svelte");
  await mod.scmStore.initWatcherListener();
  return mod.scmStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scmStore.warm", () => {
  it("caches the repo summary so a later activation serves it without fetching", async () => {
    gitRepoRootMock.mockResolvedValue({ ok: true, data: "/repoA" });
    gitSummaryMock.mockResolvedValue({ ok: true, data: makeSummary("/repoA", "a.ts") });
    const store = await freshStore();

    await store.warm("/repoA/src");
    expect(gitSummaryMock).toHaveBeenCalledWith("/repoA");
    // Warming must not start the watcher — that stays a panel-mounted concern.
    expect(gitWatchRepoMock).not.toHaveBeenCalled();

    // Activating with a summary fetch that never resolves: the cached summary
    // from the warm must appear immediately, without a pending flash.
    gitSummaryMock.mockImplementation(() => new Promise(() => {}));
    void store.setActivePath("/repoA/lib");
    await flushMicrotasks();

    expect(store.summary.is_repo).toBe(true);
    expect(store.summary.changes.map((c) => c.path)).toEqual(["a.ts"]);
    expect(store.pending).toBe(false);
  });

  it("caches nothing for a non-repo path", async () => {
    gitRepoRootMock.mockResolvedValue({ ok: true, data: null });
    const store = await freshStore();

    await store.warm("/plain/folder");
    expect(gitSummaryMock).not.toHaveBeenCalled();
  });

  it("does not re-fetch when warming an already-cached repo", async () => {
    gitRepoRootMock.mockResolvedValue({ ok: true, data: "/repoA" });
    gitSummaryMock.mockResolvedValue({ ok: true, data: makeSummary("/repoA", "a.ts") });
    const store = await freshStore();

    await store.warm("/repoA/src");
    await store.warm("/repoA/other");

    expect(gitSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing probe without throwing", async () => {
    gitRepoRootMock.mockRejectedValue(new Error("ipc down"));
    const store = await freshStore();

    await expect(store.warm("/repoA/src")).resolves.toBeUndefined();
    expect(gitSummaryMock).not.toHaveBeenCalled();
  });
});
