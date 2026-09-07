import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ log: vi.fn(), summary: vi.fn() }));
vi.mock("$lib/api/git-log", () => ({ gitLog: api.log }));
// A real async boundary matters: Vitest observes promises returned directly by
// spies to record settled results, which otherwise hides abandoned rejections.
vi.mock("$lib/state/git-summary-cache", () => ({ fetchGitSummary: async () => api.summary() }));

beforeEach(() => {
  vi.resetModules();
  api.log.mockReset();
  api.summary.mockReset().mockResolvedValue({ ok: true, data: { staged: [], changes: [], untracked: [], merge: [] } });
});

const page = { commits: [], refs: {}, has_more: false, head_branch: "old", next_cursor: null };
const snapshot = { commits: [], refs: {}, hasMore: false, headOid: null,
  headBranch: "new", nextCursor: null, workingChanges: 0 };

describe("graph snapshot publication", () => {
  it("observes both concurrent failures when history and its summary reject", async () => {
    api.log.mockRejectedValueOnce(new Error("log failed"));
    api.summary.mockRejectedValueOnce(new Error("summary failed"));
    const cache = await import("$lib/state/git-graph-cache");
    await expect(cache.fetchPage0Snapshot("/failed-repo")).rejects.toThrow(/(?:log|summary) failed/);
    // Give the runtime an event-loop boundary to report an abandoned rejection.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("does not resurrect a warm snapshot invalidated while the log was pending", async () => {
    let resolve!: (value: typeof page) => void;
    api.log.mockReturnValue(new Promise((done) => { resolve = done; }));
    const cache = await import("$lib/state/git-graph-cache");
    const warming = cache.warmGraphSnapshot("/repo");
    cache.evictRepoSnapshots("/repo");
    resolve(page);
    await warming;
    expect(cache.getSnapshot(cache.snapshotKey("/repo", null, false))).toBeUndefined();
  });

  it("does not let an older warm overwrite a newer visible graph snapshot", async () => {
    let resolve!: (value: typeof page) => void;
    api.log.mockReturnValue(new Promise((done) => { resolve = done; }));
    const cache = await import("$lib/state/git-graph-cache");
    const key = cache.snapshotKey("/repo", null, false);
    const warming = cache.warmGraphSnapshot("/repo");
    cache.cacheSnapshot(key, snapshot);
    resolve(page);
    await warming;
    expect(cache.getSnapshot(key)?.headBranch).toBe("new");
  });

  it("invalidates hidden snapshots after local mutations from another surface", async () => {
    const cache = await import("$lib/state/git-graph-cache");
    const { notifyLocalGitChange } = await import("$lib/state/git-refresh");
    const key = cache.snapshotKey("/repo", null, false);
    cache.cacheSnapshot(key, snapshot);
    notifyLocalGitChange("/repo");
    expect(cache.getSnapshot(key)).toBeUndefined();
  });

  it("invalidates repository paths containing key delimiters", async () => {
    const cache = await import("$lib/state/git-graph-cache");
    const key = cache.snapshotKey("/repo|with-pipe", null, false);
    cache.cacheSnapshot(key, snapshot);
    cache.evictRepoSnapshots("/repo|with-pipe");
    expect(cache.getSnapshot(key)).toBeUndefined();
  });
});

it("does not retain a canceled summary as a clean working tree", async () => {
  api.summary.mockResolvedValueOnce({ ok: false, error: "cancelled" });
  api.log.mockResolvedValue(page);
  const cache = await import("$lib/state/git-graph-cache");
  const key = cache.snapshotKey("/repo", null, false);
  await cache.warmGraphSnapshot("/repo");
  expect(cache.getSnapshot(key)).toBeUndefined();
  await cache.warmGraphSnapshot("/repo");
  expect(cache.getSnapshot(key)?.workingChanges).toBe(0);
});
