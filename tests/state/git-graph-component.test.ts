import { describe, expect, it, vi } from "vitest";
import { createLazyComponentCache } from "$lib/state/git-graph-component";

describe("lazy component cache", () => {
  it("shares pending loads and exposes the resolved value synchronously for remounts", async () => {
    const cache = createLazyComponentCache<object>();
    const component = {};
    const loader = vi.fn(async () => component);
    expect(cache.current).toBeUndefined();
    const first = cache.load(loader);
    const second = cache.load(loader);
    expect(await first).toBe(component);
    expect(await second).toBe(component);
    expect(cache.current).toBe(component);
    await cache.load(loader);
    expect(loader).toHaveBeenCalledOnce();
  });

  it("propagates failures without publishing a constructor or blocking a later load", async () => {
    const cache = createLazyComponentCache<string>();
    await expect(cache.load(() => Promise.reject(new Error("missing chunk")))).rejects.toThrow("missing chunk");
    expect(cache.current).toBeUndefined();
    await expect(cache.load(async () => "loaded")).resolves.toBe("loaded");
    expect(cache.current).toBe("loaded");
  });
});
