import { describe, expect, it, vi } from "vitest";
import { createRepoRootCache } from "$lib/state/repo-root-cache.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("repository root cache", () => {
  it("deduplicates a pending probe and lets every caller await publication", async () => {
    const lookupResult = deferred<{ ok: true; data: string }>();
    const lookup = vi.fn(() => lookupResult.promise);
    const cache = createRepoRootCache(lookup);
    const first = cache.ensure("/repo/src");
    const second = cache.ensure("/repo/src/");
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledOnce();
    expect(cache.get("/repo/src")).toBeUndefined();
    lookupResult.resolve({ ok: true, data: "/repo" });
    await Promise.all([first, second]);
    expect(cache.get("/repo/src")).toBe("/repo");
  });

  it("does not publish a stale completion after invalidation", async () => {
    const oldResult = deferred<{ ok: true; data: string }>();
    const lookup = vi.fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockResolvedValueOnce({ ok: true, data: "/new-root" });
    const cache = createRepoRootCache(lookup);
    const oldEnsure = cache.ensure("/repo/src");
    await Promise.resolve();
    cache.invalidate("/repo");
    const replacement = cache.ensure("/repo/src");
    await replacement;
    oldResult.resolve({ ok: true, data: "/old-root" });
    await oldEnsure;
    expect(cache.get("/repo/src")).toBe("/new-root");
  });

  it("retries failed and rejected probes", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "offline" })
      .mockRejectedValueOnce(new Error("transport"))
      .mockResolvedValueOnce({ ok: true, data: "/repo" });
    const cache = createRepoRootCache(lookup);
    await cache.ensure("/repo/src");
    await cache.ensure("/repo/src");
    await cache.ensure("/repo/src");
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(cache.get("/repo/src")).toBe("/repo");
  });

  it("evicts the least recently used resolved path at capacity", async () => {
    const cache = createRepoRootCache(async (path) => ({ ok: true, data: path }), 2);
    await cache.ensure("/one");
    await cache.ensure("/two");
    expect(cache.get("/one")).toBe("/one");
    await cache.ensure("/three");
    expect(cache.get("/one")).toBe("/one");
    expect(cache.get("/two")).toBeUndefined();
    expect(cache.get("/three")).toBe("/three");
  });

  it("keeps stale display values while expiry makes probes eligible for refresh", async () => {
    let time = 0;
    const lookup = vi.fn(async (path: string) => ({ ok: true as const, data: path === "/none" ? null : "/repo" }));
    const cache = createRepoRootCache(lookup, 10, () => time);
    await cache.ensure("/none");
    await cache.ensure("/repo/src");
    time = 2_001;
    expect(cache.get("/none")).toBeNull();
    expect(cache.get("/repo/src")).toBe("/repo");
    await cache.ensure("/none");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("replaces a stale displayed root only after revalidation completes", async () => {
    let time = 0;
    const refreshed = deferred<{ ok: true; data: string }>();
    const lookup = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: "/old-root" })
      .mockReturnValueOnce(refreshed.promise);
    const cache = createRepoRootCache(lookup, 10, () => time);
    await cache.ensure("/repo/src");
    time = 60_001;

    const refresh = cache.ensure("/repo/src");
    expect(cache.get("/repo/src")).toBe("/old-root");
    refreshed.resolve({ ok: true, data: "/new-root" });
    await refresh;
    expect(cache.get("/repo/src")).toBe("/new-root");
  });

  it("invalidates only overlapping roots", async () => {
    const cache = createRepoRootCache(async (path) => ({ ok: true, data: path }));
    await cache.ensure("/repo/a/src");
    await cache.ensure("/repo/b/src");
    cache.invalidate("/repo/a");
    expect(cache.get("/repo/a/src")).toBeUndefined();
    expect(cache.get("/repo/b/src")).toBe("/repo/b/src");
  });
});
