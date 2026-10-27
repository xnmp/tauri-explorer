import { describe, expect, it } from "vitest";
import { createVersionedLru } from "../../src/lib/domain/versioned-lru";

const lru = (maxEntries = 3, maxWeight = 100) => createVersionedLru<string>({ maxEntries, maxWeight }, (value) => value.length);

describe("createVersionedLru (#1418)", () => {
  it("hits only the exact version stored", () => {
    const cache = lru();
    cache.set("/a.md", "v1", "one");
    expect(cache.get("/a.md", "v1")).toBe("one");
    expect(cache.get("/a.md", "v2")).toBeUndefined();
    expect(cache.get("/b.md", "v1")).toBeUndefined();
  });

  it("storing a new version drops the old one", () => {
    const cache = lru();
    cache.set("/a.md", "v1", "one");
    cache.set("/a.md", "v2", "two");
    expect(cache.get("/a.md", "v1")).toBeUndefined();
    expect(cache.get("/a.md", "v2")).toBe("two");
    expect(cache.size).toBe(1);
  });

  it("evicts the least recently used entry beyond the entry bound", () => {
    const cache = lru(2);
    cache.set("a", "1", "a");
    cache.set("b", "1", "b");
    cache.get("a", "1"); // a is now more recent than b
    cache.set("c", "1", "c");
    expect(cache.get("b", "1")).toBeUndefined();
    expect(cache.get("a", "1")).toBe("a");
    expect(cache.get("c", "1")).toBe("c");
  });

  it("evicts by total weight, but never the most recent entry", () => {
    const cache = lru(10, 10);
    cache.set("a", "1", "xxxx");
    cache.set("b", "1", "yyyy");
    cache.set("c", "1", "zzzz"); // 12 > 10: a goes
    expect(cache.get("a", "1")).toBeUndefined();
    expect(cache.size).toBe(2);
    cache.set("huge", "1", "h".repeat(50));
    expect(cache.size).toBe(1);
    expect(cache.get("huge", "1")).toHaveLength(50);
  });

  it("clear forgets everything", () => {
    const cache = lru();
    cache.set("a", "1", "a");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a", "1")).toBeUndefined();
  });
});
