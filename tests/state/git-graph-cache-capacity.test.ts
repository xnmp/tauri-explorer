/** Cache capacity contract for the supported git-graph tab fan-out (#505). */
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheSnapshot,
  evictRepoSnapshots,
  getSnapshot,
  snapshotKey,
  type GraphSnapshot,
} from "$lib/state/git-graph-cache";

const tabRepos = Array.from({ length: 17 }, (_, index) => `/home/user/graph-tab-${index}`);

const snap = (): GraphSnapshot => ({
  commits: [], refs: {}, hasMore: false, headOid: null, headBranch: null,
  workingChanges: 0, nextCursor: null,
});

afterEach(() => {
  for (const repo of tabRepos) evictRepoSnapshots(repo);
});

describe("git-graph cache capacity", () => {
  it("retains every graph in the supported 12-tab fan-out", () => {
    const keys = tabRepos.slice(0, 12).map((repo) => snapshotKey(repo, null, false));
    for (const key of keys) cacheSnapshot(key, snap());
    for (const key of keys) expect(getSnapshot(key)).toBeDefined();
  });

  it("is bounded to 16 snapshots and evicts the oldest entry", () => {
    const keys = tabRepos.map((repo) => snapshotKey(repo, null, false));
    for (const key of keys) cacheSnapshot(key, snap());

    expect(getSnapshot(keys[0])).toBeUndefined();
    for (const key of keys.slice(1)) expect(getSnapshot(key)).toBeDefined();
  });
});
