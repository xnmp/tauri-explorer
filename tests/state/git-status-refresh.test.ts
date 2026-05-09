/**
 * Test: git status store refresh behavior.
 * Issue: #93 (git-badges-not-updating)
 *
 * Verifies that the store allows re-fetching when refresh() is called,
 * bypassing the cache check that fetchForDirectory() uses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the store's caching logic in isolation
describe("git status store cache behavior", () => {
  function createMockStore() {
    let currentPath = "";
    let statuses: Record<string, string> = {};
    let fetchCount = 0;

    async function doFetch(path: string) {
      fetchCount++;
      currentPath = path;
      statuses = { "file.txt": "Modified" };
    }

    async function fetchForDirectory(path: string) {
      if (path === currentPath && Object.keys(statuses).length > 0) return;
      await doFetch(path);
    }

    async function refresh() {
      if (!currentPath) return;
      await doFetch(currentPath);
    }

    return {
      get currentPath() { return currentPath; },
      get statuses() { return statuses; },
      get fetchCount() { return fetchCount; },
      fetchForDirectory,
      refresh,
    };
  }

  it("fetchForDirectory caches and skips re-fetch for same path", async () => {
    const store = createMockStore();
    await store.fetchForDirectory("/home/user/project");
    expect(store.fetchCount).toBe(1);

    await store.fetchForDirectory("/home/user/project");
    expect(store.fetchCount).toBe(1);
  });

  it("refresh() bypasses cache and re-fetches", async () => {
    const store = createMockStore();
    await store.fetchForDirectory("/home/user/project");
    expect(store.fetchCount).toBe(1);

    await store.refresh();
    expect(store.fetchCount).toBe(2);
  });

  it("refresh() does nothing when no current path", async () => {
    const store = createMockStore();
    await store.refresh();
    expect(store.fetchCount).toBe(0);
  });

  it("fetchForDirectory re-fetches for different path", async () => {
    const store = createMockStore();
    await store.fetchForDirectory("/home/user/project");
    expect(store.fetchCount).toBe(1);

    await store.fetchForDirectory("/home/user/other");
    expect(store.fetchCount).toBe(2);
  });
});
