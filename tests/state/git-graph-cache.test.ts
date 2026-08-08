/**
 * git-graph snapshot cache (#433 / arch Finding 7): keying, LRU insert, and
 * watcher-driven eviction so a remounted graph never paints stale history.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  snapshotKey,
  cacheSnapshot,
  getSnapshot,
  evictRepoSnapshots,
  type GraphSnapshot,
} from "$lib/state/git-graph-cache";
import { emitWatcherGitChange, notifyLocalGitChange } from "$lib/state/git-refresh";

const snap = (): GraphSnapshot => ({
  commits: [],
  refs: {},
  hasMore: false,
  headOid: null,
  headBranch: null,
  workingChanges: 0,
  nextCursor: null,
});

describe("git-graph-cache", () => {
  const repo = "/home/user/project";

  beforeEach(() => {
    // Clear any keys a prior test left behind.
    evictRepoSnapshots(repo);
    evictRepoSnapshots("/other/repo");
  });

  it("keys distinctly on repo, filter and local-only", () => {
    expect(snapshotKey(repo, null, false)).not.toBe(snapshotKey(repo, null, true));
    expect(snapshotKey(repo, ["main"], false)).not.toBe(snapshotKey(repo, ["dev"], false));
    expect(snapshotKey(repo, ["a", "b"], false)).toBe(snapshotKey(repo, ["a", "b"], false));
  });

  it("stores and retrieves a snapshot by key", () => {
    const key = snapshotKey(repo, null, false);
    expect(getSnapshot(key)).toBeUndefined();
    cacheSnapshot(key, snap());
    expect(getSnapshot(key)).toBeDefined();
  });

  it("evicts every filter variant for a repo but leaves other repos", () => {
    const unfiltered = snapshotKey(repo, null, false);
    const filtered = snapshotKey(repo, ["main"], false);
    const other = snapshotKey("/other/repo", null, false);
    cacheSnapshot(unfiltered, snap());
    cacheSnapshot(filtered, snap());
    cacheSnapshot(other, snap());

    evictRepoSnapshots(repo);

    expect(getSnapshot(unfiltered)).toBeUndefined();
    expect(getSnapshot(filtered)).toBeUndefined();
    expect(getSnapshot(other)).toBeDefined();
  });

  it("evicts on an external (watcher) git change, ignores local mutations", () => {
    const localKey = snapshotKey(repo, null, false);
    cacheSnapshot(localKey, snap());

    // A local mutation is re-cached by the mounted view — the cache leaves it.
    notifyLocalGitChange(repo);
    expect(getSnapshot(localKey)).toBeDefined();

    // An external change invalidates it so the next remount refetches.
    emitWatcherGitChange(repo);
    expect(getSnapshot(localKey)).toBeUndefined();
  });
});
