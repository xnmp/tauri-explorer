/**
 * Tests for pruneNonExistent in frecency and recent-files stores.
 *
 * The prune awaits a backend existence check; entries added while awaiting
 * must survive (filtering must use path membership against the snapshot,
 * not indices into a possibly-changed array).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const checkPathsExistMock = vi.fn<(paths: string[]) => Promise<boolean[]>>();
vi.mock("$lib/api/files", () => ({
  checkPathsExist: (paths: string[]) => checkPathsExistMock(paths),
}));

import { frecencyStore } from "$lib/state/frecency.svelte";
import { recentFilesStore } from "$lib/state/recent-files.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  frecencyStore.clear();
  recentFilesStore.clear();
});

describe("frecencyStore.pruneNonExistent", () => {
  it("removes only the paths reported missing", async () => {
    frecencyStore.recordAccess("/keep");
    frecencyStore.recordAccess("/gone");
    checkPathsExistMock.mockResolvedValue([true, false]);

    await frecencyStore.pruneNonExistent();

    expect(frecencyStore.entries.map((e) => e.path)).toEqual(["/keep"]);
  });

  it("keeps entries recorded while the existence check is in flight", async () => {
    frecencyStore.recordAccess("/a");
    frecencyStore.recordAccess("/b");

    let resolveCheck!: (v: boolean[]) => void;
    checkPathsExistMock.mockReturnValue(new Promise((r) => (resolveCheck = r)));

    const prune = frecencyStore.pruneNonExistent();
    // A new path is recorded mid-prune; it was not part of the snapshot
    frecencyStore.recordAccess("/added-during-prune");
    resolveCheck([true, false]); // /a exists, /b is gone
    await prune;

    const paths = frecencyStore.entries.map((e) => e.path);
    expect(paths).toContain("/a");
    expect(paths).toContain("/added-during-prune");
    expect(paths).not.toContain("/b");
  });

  it("does nothing when the store is empty", async () => {
    await frecencyStore.pruneNonExistent();
    expect(checkPathsExistMock).not.toHaveBeenCalled();
  });
});

describe("recentFilesStore.pruneNonExistent", () => {
  it("removes only the paths reported missing", async () => {
    recentFilesStore.add("/keep", "keep", "file");
    recentFilesStore.add("/gone", "gone", "file");
    // Entries are newest-first: ["/gone", "/keep"]
    checkPathsExistMock.mockResolvedValue([false, true]);

    await recentFilesStore.pruneNonExistent();

    expect(recentFilesStore.list.map((e) => e.path)).toEqual(["/keep"]);
  });

  it("keeps entries added while the existence check is in flight", async () => {
    recentFilesStore.add("/a", "a", "file");
    recentFilesStore.add("/b", "b", "directory");
    // Snapshot order is newest-first: ["/b", "/a"]
    let resolveCheck!: (v: boolean[]) => void;
    checkPathsExistMock.mockReturnValue(new Promise((r) => (resolveCheck = r)));

    const prune = recentFilesStore.pruneNonExistent();
    recentFilesStore.add("/added-during-prune", "added", "file");
    resolveCheck([true, false]); // /b exists, /a is gone
    await prune;

    const paths = recentFilesStore.list.map((e) => e.path);
    expect(paths).toContain("/b");
    expect(paths).toContain("/added-during-prune");
    expect(paths).not.toContain("/a");
  });
});
