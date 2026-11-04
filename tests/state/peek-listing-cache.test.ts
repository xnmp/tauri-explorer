import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryChange } from "$lib/state/directory-events";

const { subscribers } = vi.hoisted(() => ({ subscribers: [] as ((change: DirectoryChange) => void)[] }));
vi.mock("$lib/state/directory-events", () => ({
  directoryEvents: { subscribe: (callback: (change: DirectoryChange) => void) => { subscribers.push(callback); return { ready: async () => {}, stop() {} }; } },
}));
import { createPeekListingCache, peekListingCache } from "$lib/state/peek-listing-cache";
import { broadcastFileChange } from "$lib/state/file-events";

const files = (dir: string, count: number): FileEntry[] => Array.from({ length: count }, (_, i) => ({ path: `${dir}/f${i}`, name: `f${i}`, kind: "file", size: 1, modified: "" }));

describe("createPeekListingCache", () => {
  it("returns the remembered listing by path identity", () => {
    const cache = createPeekListingCache({ windows: false });
    const entries = files("/r/a", 2);
    cache.put("/r/a/", entries);
    expect(cache.get("/r/a")).toBe(entries);
    expect(cache.get("/r/b")).toBeUndefined();
  });

  it("folds only the Windows root case", () => {
    const cache = createPeekListingCache({ windows: true });
    const entries = files("C:/x", 1);
    cache.put("C:\\x", entries);
    expect(cache.get("c:/x")).toBe(entries);
    expect(cache.get("C:/X")).toBeUndefined();
  });

  it("evicts least recently used directories past its bounds", () => {
    const cache = createPeekListingCache({ windows: false, maxDirectories: 2, maxEntries: 5, maxListing: 4 });
    cache.put("/a", files("/a", 2));
    cache.put("/b", files("/b", 2));
    cache.get("/a");
    cache.put("/c", files("/c", 1));
    expect(cache.get("/b")).toBeUndefined();
    expect(cache.get("/a")).toBeDefined();
    cache.put("/d", files("/d", 4));
    expect(cache.totalEntries).toBeLessThanOrEqual(5);
    cache.put("/huge", files("/huge", 5));
    expect(cache.get("/huge")).toBeUndefined();
  });

  it("invalidation forgets a directory, and replacing a listing re-counts it", () => {
    const cache = createPeekListingCache({ windows: false });
    cache.put("/a", files("/a", 3));
    cache.put("/a", files("/a", 1));
    expect(cache.totalEntries).toBe(1);
    cache.invalidate(["/a/"]);
    expect(cache.get("/a")).toBeUndefined();
    expect(cache.totalEntries).toBe(0);
  });
});

describe("peekListingCache (window-wide)", () => {
  it("watcher notifications and local mutation broadcasts evict entries", () => {
    const cache = peekListingCache();
    cache.put("/w", files("/w", 1));
    cache.put("/m", files("/m", 1));
    expect(subscribers).toHaveLength(1);
    subscribers[0]({ path: "/w", origin: "watcher", observedAt: 1 });
    expect(cache.get("/w")).toBeUndefined();
    broadcastFileChange(["/m"]);
    expect(cache.get("/m")).toBeUndefined();
    expect(peekListingCache()).toBe(cache);
  });
});
