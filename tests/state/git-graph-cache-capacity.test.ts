/**
 * Capacity coverage for #505. Kept separate from the cache's baseline
 * behavior suite because this models the high-load git-graph tab fan-out.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheSnapshot,
  evictRepoSnapshots,
  getSnapshot,
  snapshotKey,
  type GraphSnapshot,
} from "$lib/state/git-graph-cache";

const tabRepos = Array.from({ length: 17 }, (_, index) => `/home/user/graph-tab-${index}`);

const snapshot = (): GraphSnapshot => ({
  commits: [],
  refs: {},
  hasMore: false,
  headOid: null,
  headBranch: null,
  workingChanges: 0,
  nextCursor: null,
});

afterEach(() => {
  for (const repo of tabRepos) evictRepoSnapshots(repo);
});

describe("git-graph snapshot cache capacity (#505)", () => {
  it("keeps snapshots for every graph in the supported 12-tab fan-out", () => {
    const keys = tabRepos.slice(0, 12).map((repo) => snapshotKey(repo, null, false));

    for (const key of keys) cacheSnapshot(key, snapshot());

    // PaneContainer remounts a graph when its tab becomes active. Every graph
    // in the load-suite fan-out must therefore have a snapshot to paint from
    // instead of waiting for a new git log request during the switch.
    for (const key of keys) expect(getSnapshot(key)).toBeDefined();
  });

  it("bounds the snapshot cache and evicts the oldest graph after its capacity", () => {
    const keys = tabRepos.map((repo) => snapshotKey(repo, null, false));

    for (const key of keys) cacheSnapshot(key, snapshot());

    // The tab fan-out needs headroom, but snapshots remain bounded page-0
    // data. A seventeenth graph replaces the least recently inserted one.
    expect(getSnapshot(keys[0])).toBeUndefined();
    for (const key of keys.slice(1)) expect(getSnapshot(key)).toBeDefined();
  });
});
