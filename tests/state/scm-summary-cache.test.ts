/**
 * SCM summary cache + pending state (#271).
 *
 * Behavior under test:
 * - `pending` is true while repo detection / the first summary fetch is in
 *   flight, so the view can show a loading state instead of prematurely
 *   claiming "not a git repository".
 * - Switching back to an already-seen repo serves the cached summary
 *   immediately (no empty-state flash) while a background refresh runs.
 * - A watcher change on an INACTIVE repo evicts its cache entry so the next
 *   activation fetches fresh; a change on the ACTIVE repo refetches directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitStatusSummary } from "$lib/api/files";

const gitRepoRootMock = vi.fn();
const gitSummaryMock = vi.fn();

vi.mock("$lib/api/files", () => ({
  gitRepoRoot: (path: string) => gitRepoRootMock(path),
  gitSummary: (root: string) => gitSummaryMock(root),
  gitStage: vi.fn(async () => ({ ok: true })),
  gitUnstage: vi.fn(async () => ({ ok: true })),
  gitDiscard: vi.fn(async () => ({ ok: true })),
  gitCommit: vi.fn(async () => ({ ok: true })),
  gitWatchRepo: vi.fn(async () => {}),
  gitUnwatchRepo: vi.fn(async () => {}),
}));

type GitChange = { source: "watcher" | "local"; repoRoot: string | null };
let gitChangeHandler: ((change: GitChange) => void) | null = null;
vi.mock("$lib/state/git-refresh", () => ({
  subscribeGitChanges: vi.fn(async (fn: (change: GitChange) => void) => {
    gitChangeHandler = fn;
  }),
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
    op_state: "clean",
  };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Fresh store per test — module reset clears the shared summary cache. */
async function freshStore() {
  vi.resetModules();
  const mod = await import("$lib/state/scm.svelte");
  const store = mod.getScmStore("test-pane");
  await store.initWatcherListener();
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  gitChangeHandler = null;
});

describe("scmStore pending state", () => {
  it("is pending during repo detection, and settles to not-a-repo only after it resolves", async () => {
    let resolveDetect: (() => void) | undefined;
    gitRepoRootMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetect = () => resolve({ ok: true, data: null });
        }),
    );
    const store = await freshStore();

    const activation = store.setActivePath("/plain-folder");
    await flushMicrotasks();
    expect(store.pending).toBe(true);

    resolveDetect?.();
    await activation;
    expect(store.pending).toBe(false);
    expect(store.summary.is_repo).toBe(false);
  });

  it("is pending during the first summary fetch of a repo", async () => {
    gitRepoRootMock.mockResolvedValue({ ok: true, data: "/repoA" });
    let resolveSummary: (() => void) | undefined;
    gitSummaryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSummary = () => resolve({ ok: true, data: makeSummary("/repoA", "a.ts") });
        }),
    );
    const store = await freshStore();

    const activation = store.setActivePath("/repoA/src");
    await flushMicrotasks();
    expect(store.pending).toBe(true);

    resolveSummary?.();
    await activation;
    expect(store.pending).toBe(false);
    expect(store.summary.changes.map((c) => c.path)).toEqual(["a.ts"]);
  });
});

describe("scmStore summary cache", () => {
  it("serves the cached summary immediately when switching back to a repo", async () => {
    gitRepoRootMock.mockImplementation(async (path: string) => ({
      ok: true,
      data: path.startsWith("/repoA") ? "/repoA" : null,
    }));
    gitSummaryMock.mockResolvedValue({ ok: true, data: makeSummary("/repoA", "a.ts") });
    const store = await freshStore();

    await store.setActivePath("/repoA/src");
    expect(store.summary.is_repo).toBe(true);

    await store.setActivePath("/plain-folder");
    expect(store.summary.is_repo).toBe(false);

    // Switch back with a summary fetch that never resolves within the test:
    // the cached summary must appear anyway, without a pending flash.
    gitSummaryMock.mockImplementation(() => new Promise(() => {}));
    void store.setActivePath("/repoA/lib");
    await flushMicrotasks();

    expect(store.summary.is_repo).toBe(true);
    expect(store.summary.changes.map((c) => c.path)).toEqual(["a.ts"]);
    expect(store.pending).toBe(false);
  });

  it("refetches on a watcher change for the active repo", async () => {
    gitRepoRootMock.mockResolvedValue({ ok: true, data: "/repoA" });
    gitSummaryMock.mockResolvedValue({ ok: true, data: makeSummary("/repoA", "a.ts") });
    const store = await freshStore();
    await store.setActivePath("/repoA/src");

    gitSummaryMock.mockClear();
    gitSummaryMock.mockResolvedValue({ ok: true, data: makeSummary("/repoA", "b.ts") });
    gitChangeHandler?.({ source: "watcher", repoRoot: "/repoA" });
    await flushMicrotasks();

    expect(gitSummaryMock).toHaveBeenCalledWith("/repoA");
    expect(store.summary.changes.map((c) => c.path)).toEqual(["b.ts"]);
  });

  it("evicts an inactive repo's cache entry on a watcher change, forcing a fresh fetch", async () => {
    gitRepoRootMock.mockImplementation(async (path: string) => ({
      ok: true,
      data: path.startsWith("/repoA") ? "/repoA" : "/repoB",
    }));
    gitSummaryMock.mockImplementation(async (root: string) => ({
      ok: true,
      data: makeSummary(root, root === "/repoA" ? "a.ts" : "b.ts"),
    }));
    const store = await freshStore();

    await store.setActivePath("/repoB/src"); // cache /repoB
    await store.setActivePath("/repoA/src"); // switch away

    // /repoB changes while inactive.
    gitChangeHandler?.({ source: "watcher", repoRoot: "/repoB" });

    // Switching back must NOT serve the stale cached summary.
    let resolveSummary: (() => void) | undefined;
    gitSummaryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSummary = () => resolve({ ok: true, data: makeSummary("/repoB", "b2.ts") });
        }),
    );
    const activation = store.setActivePath("/repoB/lib");
    await flushMicrotasks();
    expect(store.summary.is_repo).toBe(false);
    expect(store.pending).toBe(true);

    resolveSummary?.();
    await activation;
    expect(store.summary.changes.map((c) => c.path)).toEqual(["b2.ts"]);
  });
});
