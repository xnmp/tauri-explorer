/**
 * Images a Preview pane has already shown (#1014): a revisit of an unchanged
 * file is a synchronous hit, a changed file misses, and retained blobs are
 * bounded and revoked on eviction and teardown.
 */
import { describe, expect, it, vi } from "vitest";
import { createPreviewImageCache } from "$lib/state/preview-image-cache";
import type { PreviewImageReady } from "$lib/state/preview-image";
import type { PreviewImageResolution } from "$lib/domain/preview-rendition";

const rendition = (maxEdge = 2048) => ({ rendition: { maxEdge } });
const original = {};

function image(url: string, resolution: PreviewImageResolution = "rendition", width = 100, height = 100): PreviewImageReady {
  return {
    status: "ready",
    url,
    viaBackend: url.startsWith("blob:"),
    resolution,
    decoded: { naturalWidth: width, naturalHeight: height } as HTMLImageElement,
  };
}

const limits = { maxEntries: 3, maxPixels: 1_000_000 };

describe("preview image cache", () => {
  it("returns a shown image for the same file version and request", () => {
    const cache = createPreviewImageCache(vi.fn(), limits);
    const shown = image("asset://localhost/r.jpg?v=1");
    cache.store("/p/a.png", "1-10-0", rendition(), shown);

    expect(cache.lookup("/p/a.png", "1-10-0", rendition())).toBe(shown);
    expect(cache.lookup("/p/b.png", "1-10-0", rendition())).toBeNull();
  });

  it("misses when the file changed: modification time, size or local preview revision", () => {
    const cache = createPreviewImageCache(vi.fn(), limits);
    cache.store("/p/a.png", "1-10-0", rendition(), image("asset://localhost/r.jpg?v=1-10-0"));

    expect(cache.lookup("/p/a.png", "2-10-0", rendition())).toBeNull();
    expect(cache.lookup("/p/a.png", "1-11-0", rendition())).toBeNull();
    expect(cache.lookup("/p/a.png", "1-10-1", rendition())).toBeNull();
  });

  it("drops an older version of a file once its new version is stored", () => {
    const revoke = vi.fn();
    const cache = createPreviewImageCache(revoke, limits);
    cache.store("/p/a.png", "1", rendition(), image("blob:old"));
    cache.store("/p/a.png", "2", rendition(), image("blob:new"));

    expect(revoke.mock.calls).toEqual([["blob:old"]]);
    expect(cache.lookup("/p/a.png", "1", rendition())).toBeNull();
    expect(cache.lookup("/p/a.png", "2", rendition())?.url).toBe("blob:new");
  });

  it("serves a rendition request from a remembered original, but not the reverse", () => {
    const cache = createPreviewImageCache(vi.fn(), limits);
    cache.store("/p/full.png", "v", original, image("asset://localhost/full.png?v=v", "original"));
    cache.store("/p/small.png", "v", rendition(), image("asset://localhost/r.jpg?v=v", "rendition"));

    expect(cache.lookup("/p/full.png", "v", rendition())?.resolution).toBe("original");
    expect(cache.lookup("/p/small.png", "v", original)).toBeNull();
    // A rendition at another edge is a different image.
    expect(cache.lookup("/p/small.png", "v", rendition(3072))).toBeNull();
  });

  it("evicts the least recently used entry beyond the entry limit and revokes its blob", () => {
    const revoke = vi.fn();
    const cache = createPreviewImageCache(revoke, limits);
    cache.store("/a", "v", rendition(), image("blob:a"));
    cache.store("/b", "v", rendition(), image("blob:b"));
    cache.store("/c", "v", rendition(), image("blob:c"));
    cache.lookup("/a", "v", rendition()); // /a is now more recent than /b
    cache.store("/d", "v", rendition(), image("blob:d"));

    expect(revoke.mock.calls).toEqual([["blob:b"]]);
    expect(cache.size).toBe(3);
    expect(cache.lookup("/b", "v", rendition())).toBeNull();
    expect(cache.lookup("/a", "v", rendition())?.url).toBe("blob:a");
  });

  it("evicts by decoded pixels, but never the most recent entry", () => {
    const revoke = vi.fn();
    const cache = createPreviewImageCache(revoke, limits);
    cache.store("/a", "v", rendition(), image("blob:a", "rendition", 600, 1000));
    cache.store("/b", "v", rendition(), image("blob:b", "rendition", 600, 1000));
    expect(revoke.mock.calls).toEqual([["blob:a"]]);

    // Larger than the whole budget on its own: kept, since it is on screen.
    cache.store("/huge", "v", original, image("blob:huge", "original", 4000, 3000));
    expect(revoke.mock.calls).toEqual([["blob:a"], ["blob:b"]]);
    expect(cache.lookup("/huge", "v", original)?.url).toBe("blob:huge");
    expect(cache.size).toBe(1);
  });

  it("does not revoke a blob another entry still holds, nor an asset URL", () => {
    const revoke = vi.fn();
    const cache = createPreviewImageCache(revoke, { maxEntries: 1, maxPixels: 1_000_000 });
    cache.store("/a", "v", rendition(), image("blob:shared"));
    cache.store("/a", "v", original, image("blob:shared", "original"));
    expect(revoke).not.toHaveBeenCalled();

    cache.store("/b", "v", rendition(), image("asset://localhost/b.jpg?v=v"));
    expect(revoke.mock.calls).toEqual([["blob:shared"]]);
    cache.store("/c", "v", rendition(), image("blob:c"));
    expect(revoke.mock.calls).toEqual([["blob:shared"]]);
  });

  it("storing the image already remembered keeps it and its blob", () => {
    const revoke = vi.fn();
    const cache = createPreviewImageCache(revoke, limits);
    const shown = image("blob:a");
    cache.store("/a", "v", rendition(), shown);
    cache.store("/a", "v", rendition(), shown);

    expect(revoke).not.toHaveBeenCalled();
    expect(cache.lookup("/a", "v", rendition())).toBe(shown);
  });

  it("clear releases every blob it holds", () => {
    const revoke = vi.fn();
    const cache = createPreviewImageCache(revoke, limits);
    cache.store("/a", "v", rendition(), image("blob:a"));
    cache.store("/b", "v", rendition(), image("asset://localhost/b.jpg?v=v"));
    cache.store("/c", "v", original, image("blob:c", "original"));
    cache.clear();

    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(["blob:a", "blob:c"]);
    expect(cache.size).toBe(0);
    expect(cache.lookup("/a", "v", rendition())).toBeNull();
  });
});
