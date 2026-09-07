import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ watch: vi.fn(), unwatch: vi.fn() }));
vi.mock("$lib/state/git-graph-coverage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/state/git-graph-coverage")>();
  const { createDirectoryWatch } = await import("$lib/state/directory-watch");
  return { ...actual, gitGraphCoverage: actual.createGitGraphCoverage({
    listen: async () => true,
    createWatch: () => createDirectoryWatch(native),
  }) };
});
const snapshot = { commits: [], refs: {}, hasMore: false, headOid: "head",
  headBranch: "main", workingChanges: 0, nextCursor: null };

beforeEach(() => {
  vi.resetModules();
  native.watch.mockReset().mockResolvedValue(undefined);
  native.unwatch.mockReset().mockResolvedValue(undefined);
});

describe("retained graph observation", () => {
  it("transfers coverage from writer to snapshots and keeps shared variants observed until invalidation", async () => {
    const cache = await import("$lib/state/git-graph-cache");
    for (const branches of [null, ["main"]]) {
      const writer = cache.beginSnapshotWrite(cache.snapshotKey("/repo", branches, false), "/repo");
      await writer.ready;
      expect(writer.publish(snapshot)).toBe(true);
      writer.dispose();
    }
    expect(native.watch).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(native.unwatch).not.toHaveBeenCalled();
    cache.evictRepoSnapshots("/repo");
    await vi.waitFor(() => expect(native.unwatch).toHaveBeenCalledExactlyOnceWith("/repo"));
  });

  it("releases the least recently used repository and preserves the supported tab fan-out", async () => {
    const cache = await import("$lib/state/git-graph-cache");
    const keys = Array.from({ length: 17 }, (_, i) => cache.snapshotKey(`/repo-${i}`, null, false));
    for (let i = 0; i < keys.length; i++) {
      const writer = cache.beginSnapshotWrite(keys[i], `/repo-${i}`);
      await writer.ready;
      writer.publish(snapshot); writer.dispose();
      if (i === 15) cache.getSnapshot(keys[0]);
    }
    expect(cache.getSnapshot(keys[1])).toBeUndefined();
    expect(cache.getSnapshot(keys[0])).toBeDefined();
    for (const key of keys.slice(5)) expect(cache.getSnapshot(key)).toBeDefined();
    await vi.waitFor(() => expect(native.unwatch).toHaveBeenCalledExactlyOnceWith("/repo-1"));
    for (let i = 0; i < keys.length; i++) cache.evictRepoSnapshots(`/repo-${i}`);
    await vi.waitFor(() => expect(native.unwatch).toHaveBeenCalledTimes(17));
  });

  it("rejects publication before acknowledgement and after delivered invalidation", async () => {
    let acknowledge!: () => void;
    native.watch.mockReturnValue(new Promise<void>((resolve) => { acknowledge = resolve; }));
    const cache = await import("$lib/state/git-graph-cache");
    const key = cache.snapshotKey("/repo", null, false);
    const writer = cache.beginSnapshotWrite(key, "/repo");
    expect(writer.publish(snapshot)).toBe(false);
    await vi.waitFor(() => expect(native.watch).toHaveBeenCalledOnce());
    cache.evictRepoSnapshots("/repo");
    acknowledge();
    await expect(writer.ready).resolves.toBe(false);
    expect(writer.publish(snapshot)).toBe(false);
    expect(cache.getSnapshot(key)).toBeUndefined();
    writer.dispose();
    await vi.waitFor(() => expect(native.unwatch).toHaveBeenCalledExactlyOnceWith("/repo"));
  });

  it("does not cache after failed native acquisition and retries on the next read", async () => {
    native.watch.mockRejectedValueOnce(new Error("watch denied"));
    const cache = await import("$lib/state/git-graph-cache");
    const key = cache.snapshotKey("/repo", null, false);
    const failed = cache.beginSnapshotWrite(key, "/repo");
    await expect(failed.ready).resolves.toBe(false);
    expect(failed.publish(snapshot)).toBe(false);
    failed.dispose();
    const retry = cache.beginSnapshotWrite(key, "/repo");
    await expect(retry.ready).resolves.toBe(true);
    expect(retry.publish(snapshot)).toBe(true);
    retry.dispose();
    cache.evictRepoSnapshots("/repo");
    await vi.waitFor(() => expect(native.unwatch).toHaveBeenCalledOnce());
  });
});
