/**
 * Frontend thumbnail data URI cache.
 * Survives renames without requiring backend re-generation.
 */

interface CachedThumbnail {
  micro: string | null;
  full: string | null;
}

// Keyed by reloadKey: `${path}:${backendSize}:${quality}`
const cache = new Map<string, CachedThumbnail>();

export function getThumbnailCache(key: string): CachedThumbnail | undefined {
  return cache.get(key);
}

export function setThumbnailCache(key: string, value: CachedThumbnail): void {
  cache.set(key, value);
}

export function renameThumbnailCache(oldPath: string, newPath: string): void {
  for (const [key, value] of cache) {
    if (key.startsWith(oldPath + ":")) {
      const newKey = newPath + key.slice(oldPath.length);
      cache.set(newKey, value);
      cache.delete(key);
    }
  }
}
