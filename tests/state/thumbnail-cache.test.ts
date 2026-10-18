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
  it("re-keys the renamed entry itself", () => {
    setThumbnailCache("/pics/cat.png:64:80", entry("cat"));

    renameThumbnailCache("/pics/cat.png", "/pics/kitten.png");

    expect(getThumbnailCache("/pics/cat.png:64:80")).toBeUndefined();
    expect(getThumbnailCache("/pics/kitten.png:64:80")).toEqual(entry("cat"));
  });

  it("re-keys entries under a renamed directory", () => {
    setThumbnailCache("/photos/a.png:64:80", entry("a"));
    setThumbnailCache("/photos/sub/b.png:128:90", entry("b"));
    setThumbnailCache("/photos-other/c.png:64:80", entry("c"));

    renameThumbnailCache("/photos", "/images");

    expect(getThumbnailCache("/images/a.png:64:80")).toEqual(entry("a"));
    expect(getThumbnailCache("/images/sub/b.png:128:90")).toEqual(entry("b"));
    expect(getThumbnailCache("/photos/a.png:64:80")).toBeUndefined();
    // Sibling with a shared name prefix must NOT be re-keyed
    expect(getThumbnailCache("/photos-other/c.png:64:80")).toEqual(entry("c"));
  });

  it("does not revoke blob URLs during rename", () => {
    setThumbnailCache("/docs/x.png:64:80", entry("x"));
    revokeSpy.mockClear();

    renameThumbnailCache("/docs/x.png", "/docs/y.png");

    expect(revokeSpy).not.toHaveBeenCalled();
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
