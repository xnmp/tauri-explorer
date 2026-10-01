import { describe, expect, it, vi } from "vitest";
import { createCommitFilesCache } from "$lib/state/git-commit-files-cache";

describe("commit file cache", () => {
  it("reuses immutable results while isolating repositories and commits", async () => {
    const load = vi.fn(async (repo: string, oid: string) => [{ path: `${repo}/${oid}`, status: "M" }]);
    const get = createCommitFilesCache(load);
    expect(await get("/a", "one")).toEqual([{ path: "/a/one", status: "M" }]);
    await get("/a", "one");
    expect(await get("/b", "one")).toEqual([{ path: "/b/one", status: "M" }]);
    expect(await get("/a", "two")).toEqual([{ path: "/a/two", status: "M" }]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps recently read commits when capacity is exceeded", async () => {
    const load = vi.fn(async () => []);
    const get = createCommitFilesCache(load);
    for (let i = 0; i < 50; i++) await get("/repo", `${i}`);
    await get("/repo", "0");
    await get("/repo", "new");
    load.mockClear();
    await get("/repo", "0");
    expect(load).not.toHaveBeenCalled();
    await get("/repo", "1");
    expect(load).toHaveBeenCalledWith("/repo", "1");
  });

  it("retries failed loads and caches an empty changed-file list", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    const get = createCommitFilesCache(load);
    await expect(get("/repo", "oid")).rejects.toThrow("offline");
    await expect(get("/repo", "oid")).resolves.toEqual([]);
    await expect(get("/repo", "oid")).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
