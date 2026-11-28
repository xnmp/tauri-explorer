/**
 * Tests for the thumbnail blob URL cache: bounded LRU eviction with
 * revocation, and directory-aware rename re-keying.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  getThumbnailCache,
  setThumbnailCache,
  renameThumbnailCache,
  invalidateThumbnailCache,
  subscribeThumbnailInvalidation,
  thumbnailCacheKey,
  thumbnailVersion,
} from "$lib/state/thumbnail-cache";

const revokeSpy = vi.fn();

beforeAll(() => {
  // Node's URL may not implement revokeObjectURL — install a spy either way.
  (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = revokeSpy;
});

beforeEach(() => {
  revokeSpy.mockClear();
});

function entry(name: string) {
  return { micro: `blob:micro-${name}`, full: `blob:full-${name}` };
}

describe("renameThumbnailCache", () => {
  // Real keys: `${kind}:${path}:${backendSize}:${quality}` (#1267).
  it("re-keys the renamed entry itself, every kind and size", () => {
    setThumbnailCache("image:/pics/cat.png:64:80", entry("cat"));
    setThumbnailCache("video:/pics/cat.png:256:90", entry("cat-v"));

    renameThumbnailCache("/pics/cat.png", "/pics/kitten.png");

    expect(getThumbnailCache("image:/pics/cat.png:64:80")).toBeUndefined();
    expect(getThumbnailCache("video:/pics/cat.png:256:90")).toBeUndefined();
    expect(getThumbnailCache("image:/pics/kitten.png:64:80")).toEqual(entry("cat"));
    expect(getThumbnailCache("video:/pics/kitten.png:256:90")).toEqual(entry("cat-v"));
  });

  it("re-keys entries under a renamed directory", () => {
    setThumbnailCache("image:/photos/a.png:64:80", entry("a"));
    setThumbnailCache("image:/photos/sub/b.png:128:90", entry("b"));
    setThumbnailCache("image:/photos-other/c.png:64:80", entry("c"));
    setThumbnailCache("image:/photos.png:64:80", entry("d"));

    renameThumbnailCache("/photos", "/images");

    expect(getThumbnailCache("image:/images/a.png:64:80")).toEqual(entry("a"));
    expect(getThumbnailCache("image:/images/sub/b.png:128:90")).toEqual(entry("b"));
    expect(getThumbnailCache("image:/photos/a.png:64:80")).toBeUndefined();
    // Siblings with a shared name prefix must NOT be re-keyed
    expect(getThumbnailCache("image:/photos-other/c.png:64:80")).toEqual(entry("c"));
    expect(getThumbnailCache("image:/photos.png:64:80")).toEqual(entry("d"));
  });

  it("re-keys Windows paths and paths containing colons", () => {
    setThumbnailCache("image:C:\\pics\\a.png:64:80", entry("w"));
    setThumbnailCache("image:C:\\pics\\sub\\b.png:64:80", entry("w2"));
    renameThumbnailCache("C:\\pics", "C:\\images");
    expect(getThumbnailCache("image:C:\\images\\a.png:64:80")).toEqual(entry("w"));
    expect(getThumbnailCache("image:C:\\images\\sub\\b.png:64:80")).toEqual(entry("w2"));
    setThumbnailCache("image:/odd/a:b.png:64:80", entry("c"));
    renameThumbnailCache("/odd/a:b.png", "/odd/z.png");
    expect(getThumbnailCache("image:/odd/z.png:64:80")).toEqual(entry("c"));
  });

  it("does not revoke blob URLs during rename, nor notify invalidation subscribers", () => {
    setThumbnailCache("image:/docs/x.png:64:80", entry("x"));
    revokeSpy.mockClear();
    const seen: string[] = [];
    const stop = subscribeThumbnailInvalidation(path => seen.push(path));

    renameThumbnailCache("/docs/x.png", "/docs/y.png");
    stop();

    expect(revokeSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe("LRU eviction", () => {
  it("revokes the replaced entry's blob URLs on overwrite", () => {
    setThumbnailCache("/over/a.png:64:80", entry("old"));
    revokeSpy.mockClear();

    setThumbnailCache("/over/a.png:64:80", entry("new"));

    expect(revokeSpy).toHaveBeenCalledWith("blob:micro-old");
    expect(revokeSpy).toHaveBeenCalledWith("blob:full-old");
    expect(getThumbnailCache("/over/a.png:64:80")).toEqual(entry("new"));
  });

  it("caps the cache and evicts the least-recently-used entry with revocation", () => {
    const CAP = 500;
    // Fill the cache to exactly the cap (also flushes leftovers from other tests)
    for (let i = 0; i < CAP; i++) {
      setThumbnailCache(`/lru/${i}.png:64:80`, entry(`lru-${i}`));
    }

    // Touch entry 0 so entry 1 becomes the LRU candidate
    expect(getThumbnailCache("/lru/0.png:64:80")).toBeDefined();
    revokeSpy.mockClear();

    setThumbnailCache("/lru/extra.png:64:80", entry("extra"));

    // Entry 1 (now oldest) was evicted and revoked; entry 0 survived
    expect(getThumbnailCache("/lru/1.png:64:80")).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:micro-lru-1");
    expect(revokeSpy).toHaveBeenCalledWith("blob:full-lru-1");
    expect(getThumbnailCache("/lru/0.png:64:80")).toBeDefined();
    expect(getThumbnailCache("/lru/extra.png:64:80")).toBeDefined();
  });

  it("ignores non-blob URLs when revoking", () => {
    setThumbnailCache("/plain/a.png:64:80", { micro: null, full: "data:image/png;base64,xx" });
    revokeSpy.mockClear();

    setThumbnailCache("/plain/a.png:64:80", entry("replacement"));

    expect(revokeSpy).not.toHaveBeenCalled();
  });
});

// Real keys are `${kind}:${path}:${backendSize}:${quality}` (ThumbnailImage.svelte) (#1267).
describe("invalidateThumbnailCache", () => {
  it("drops every kind, size and quality of the path, revoking their blob URLs", () => {
    setThumbnailCache("image:/crop/a.png:64:80", entry("a-small"));
    setThumbnailCache("image:/crop/a.png:256:90", entry("a-large"));
    setThumbnailCache("video:/crop/a.png:128:80", entry("a-video"));
    revokeSpy.mockClear();

    invalidateThumbnailCache("/crop/a.png");

    for (const key of ["image:/crop/a.png:64:80", "image:/crop/a.png:256:90", "video:/crop/a.png:128:80"]) {
      expect(getThumbnailCache(key)).toBeUndefined();
    }
    for (const name of ["a-small", "a-large", "a-video"]) {
      expect(revokeSpy).toHaveBeenCalledWith(`blob:micro-${name}`);
      expect(revokeSpy).toHaveBeenCalledWith(`blob:full-${name}`);
    }
  });

  it("leaves other paths alone, including ones sharing a prefix or suffix", () => {
    setThumbnailCache("image:/crop/b.png:64:80", entry("b"));
    setThumbnailCache("image:/crop/b.png.bak:64:80", entry("b-bak"));
    setThumbnailCache("image:/crop/sub/crop/b.png:64:80", entry("b-deep"));
    setThumbnailCache("image:/crop/b.png/inner.png:64:80", entry("b-inner"));
    revokeSpy.mockClear();

    invalidateThumbnailCache("/crop/b.png");

    expect(getThumbnailCache("image:/crop/b.png:64:80")).toBeUndefined();
    expect(getThumbnailCache("image:/crop/b.png.bak:64:80")).toEqual(entry("b-bak"));
    expect(getThumbnailCache("image:/crop/sub/crop/b.png:64:80")).toEqual(entry("b-deep"));
    expect(getThumbnailCache("image:/crop/b.png/inner.png:64:80")).toEqual(entry("b-inner"));
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });

  it("matches a path that itself contains colons (a Windows drive, a stray colon)", () => {
    setThumbnailCache("image:C:\\pics\\a.png:64:80", entry("win"));
    setThumbnailCache("image:/odd/a:b.png:64:80", entry("colon"));

    invalidateThumbnailCache("C:\\pics\\a.png");
    invalidateThumbnailCache("/odd/a:b.png");

    expect(getThumbnailCache("image:C:\\pics\\a.png:64:80")).toBeUndefined();
    expect(getThumbnailCache("image:/odd/a:b.png:64:80")).toBeUndefined();
  });

  it("ignores keys of an unexpected shape and unknown paths", () => {
    setThumbnailCache("garbage", entry("g"));
    expect(() => invalidateThumbnailCache("/never/cached.png")).not.toThrow();
    expect(getThumbnailCache("garbage")).toEqual(entry("g"));
  });

  it("tells subscribers which path was invalidated, until they unsubscribe", () => {
    const seen: string[] = [];
    const stop = subscribeThumbnailInvalidation(path => seen.push(path));
    invalidateThumbnailCache("/crop/c.png");
    stop();
    invalidateThumbnailCache("/crop/d.png");
    expect(seen).toEqual(["/crop/c.png"]);
  });
});

describe("renameThumbnailCache blob lifetime (#1823)", () => {
  it("revokes a blob URL it overwrites at the destination key", () => {
    setThumbnailCache("thumb:/r/old.png:256:80", entry("old"));
    setThumbnailCache("thumb:/r/new.png:256:80", entry("clobbered"));
    renameThumbnailCache("/r/old.png", "/r/new.png");
    expect(getThumbnailCache("thumb:/r/new.png:256:80")).toEqual(entry("old"));
    expect(revokeSpy).toHaveBeenCalledWith("blob:micro-clobbered");
    expect(revokeSpy).toHaveBeenCalledWith("blob:full-clobbered");
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:micro-old");
  });
});

describe("content-versioned keys (#1937)", () => {
  it("gives an edited file a different key, so the old pixels are never a hit", () => {
    const before = thumbnailCacheKey("image", "/v/a.png", 256, 80, thumbnailVersion({ modified: "2026-11-28T10:00:00.000Z", size: 100 }));
    const touched = thumbnailCacheKey("image", "/v/a.png", 256, 80, thumbnailVersion({ modified: "2026-11-28T10:00:05.000Z", size: 100 }));
    const resized = thumbnailCacheKey("image", "/v/a.png", 256, 80, thumbnailVersion({ modified: "2026-11-28T10:00:00.000Z", size: 101 }));
    setThumbnailCache(before, entry("v-old"));
    expect(getThumbnailCache(touched)).toBeUndefined();
    expect(getThumbnailCache(resized)).toBeUndefined();
    expect(getThumbnailCache(thumbnailCacheKey("image", "/v/a.png", 256, 80, thumbnailVersion({ modified: "2026-11-28T10:00:00.000Z", size: 100 })))).toEqual(entry("v-old"));
  });

  it("drops and revokes the older version when the new one is cached, keeping other sizes", () => {
    const v1 = thumbnailVersion({ modified: "2026-01-01T00:00:00Z", size: 1 });
    const v2 = thumbnailVersion({ modified: "2026-01-02T00:00:00Z", size: 1 });
    setThumbnailCache(thumbnailCacheKey("image", "C:\\v\\b.png", 256, 80, v1), entry("b1"));
    setThumbnailCache(thumbnailCacheKey("image", "C:\\v\\b.png", 64, 80, v1), entry("b1-small"));
    revokeSpy.mockClear();
    setThumbnailCache(thumbnailCacheKey("image", "C:\\v\\b.png", 256, 80, v2), entry("b2"));
    expect(getThumbnailCache(thumbnailCacheKey("image", "C:\\v\\b.png", 256, 80, v1))).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:full-b1");
    expect(getThumbnailCache(thumbnailCacheKey("image", "C:\\v\\b.png", 64, 80, v1))).toEqual(entry("b1-small"));
    expect(getThumbnailCache(thumbnailCacheKey("image", "C:\\v\\b.png", 256, 80, v2))).toEqual(entry("b2"));
  });

  it("still invalidates and renames versioned keys by path, including paths with @ and :", () => {
    const v = thumbnailVersion({ modified: "not a date: 12:00", size: 5 });
    expect(v).not.toContain(":");
    const key = thumbnailCacheKey("image", "/odd/me@host:x.png", 64, 80, v);
    setThumbnailCache(key, entry("odd"));
    renameThumbnailCache("/odd/me@host:x.png", "/odd/y.png");
    const renamed = thumbnailCacheKey("image", "/odd/y.png", 64, 80, v);
    expect(getThumbnailCache(renamed)).toEqual(entry("odd"));
    invalidateThumbnailCache("/odd/y.png");
    expect(getThumbnailCache(renamed)).toBeUndefined();
  });
});
