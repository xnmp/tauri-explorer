/**
 * Images one Preview pane has already shown (#1014).
 *
 * Without it every visit re-ran the whole load: a rendition request that
 * waits behind any decode still running for the image just left, then a fresh
 * fetch and off-screen decode, so going back to a large image showed the
 * spinner again. A hit is synchronous: the pane shows the remembered URL with
 * no request at all.
 *
 * Entries are keyed by what the image is — the file's original, or its
 * rendition at one edge — for one file version (`cacheBust`: mtime, size and
 * local preview revision), so a changed file never hits. A rendition request
 * accepts a remembered original (it is the better image); an original request
 * never accepts a rendition.
 *
 * The cache owns every blob URL it holds and keeps the decoded image element,
 * so the webview's decoded copy stays referenced. It is bounded by entry count
 * and by decoded pixels; the most recently used entry — the one on screen — is
 * never evicted. `clear()` (pane teardown) revokes every blob.
 */
import type { PreviewImageOptions, PreviewImageReady } from "./preview-image";

export interface PreviewImageCacheLimits {
  readonly maxEntries: number;
  /** Total decoded pixels (width × height) across entries. */
  readonly maxPixels: number;
}

/** About 16 2048 px renditions, or 7 at 3072 px (~190 MB as RGBA). */
export const PREVIEW_IMAGE_CACHE_LIMITS: PreviewImageCacheLimits = { maxEntries: 16, maxPixels: 48_000_000 };

export interface PreviewImageCache {
  /** A remembered image for this file version and request, now most recent; or null. */
  lookup(path: string, cacheBust: string, request: PreviewImageOptions): PreviewImageReady | null;
  /**
   * Remembers a shown image and takes ownership of its blob URL. Older
   * versions of the same file are dropped: they can never be shown again.
   */
  store(path: string, cacheBust: string, request: PreviewImageOptions, image: PreviewImageReady): void;
  /** Releases every entry (pane teardown). */
  clear(): void;
  readonly size: number;
}

interface Entry {
  readonly path: string;
  readonly cacheBust: string;
  readonly image: PreviewImageReady;
  readonly pixels: number;
}

function variantKey(path: string, cacheBust: string, variant: string): string {
  return `${path}\u0000${cacheBust}\u0000${variant}`;
}

function variantOf(image: PreviewImageReady, request: PreviewImageOptions): string {
  if (image.resolution === "original") return "original";
  return `edge:${request.rendition?.maxEdge ?? 0}`;
}

function decodedPixels(image: PreviewImageReady): number {
  const { naturalWidth, naturalHeight } = image.decoded;
  return Number.isFinite(naturalWidth * naturalHeight) ? Math.max(0, naturalWidth * naturalHeight) : 0;
}

export function createPreviewImageCache(
  revokeObjectUrl: (url: string) => void,
  limits: PreviewImageCacheLimits = PREVIEW_IMAGE_CACHE_LIMITS,
): PreviewImageCache {
  // Map order is recency order: the last entry is the most recent.
  const entries = new Map<string, Entry>();
  let pixels = 0;

  const touch = (key: string, entry: Entry): void => {
    entries.delete(key);
    entries.set(key, entry);
  };

  const remove = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    pixels -= entry.pixels;
    const { url } = entry.image;
    // A provider may hand the same blob to two versions; revoke it once unused.
    if (url.startsWith("blob:") && ![...entries.values()].some((other) => other.image.url === url)) revokeObjectUrl(url);
  };

  return {
    lookup(path, cacheBust, request) {
      const variants = request.rendition ? [`edge:${request.rendition.maxEdge}`, "original"] : ["original"];
      for (const variant of variants) {
        const key = variantKey(path, cacheBust, variant);
        const entry = entries.get(key);
        if (entry) {
          touch(key, entry);
          return entry.image;
        }
      }
      return null;
    },
    store(path, cacheBust, request, image) {
      const key = variantKey(path, cacheBust, variantOf(image, request));
      for (const [other, entry] of [...entries]) {
        if (entry.path === path && entry.cacheBust !== cacheBust) remove(other);
      }
      const existing = entries.get(key);
      if (existing?.image.url === image.url) {
        touch(key, existing);
        return;
      }
      remove(key);
      const entry: Entry = { path, cacheBust, image, pixels: decodedPixels(image) };
      entries.set(key, entry);
      pixels += entry.pixels;
      for (const oldest of entries.keys()) {
        if (entries.size <= 1 || (entries.size <= limits.maxEntries && pixels <= limits.maxPixels)) break;
        remove(oldest);
      }
    },
    clear() {
      for (const key of [...entries.keys()]) remove(key);
    },
    get size() {
      return entries.size;
    },
  };
}
