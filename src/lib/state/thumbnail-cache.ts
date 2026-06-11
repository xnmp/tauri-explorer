/**
 * Frontend thumbnail blob URL cache.
 * Survives renames without requiring backend re-generation.
 * Revokes old blob URLs on replacement to prevent memory leaks.
 *
 * Bounded LRU: the Map's insertion order tracks recency (gets re-insert),
 * and the least-recently-used entry is evicted (with its blob URLs revoked)
 * once the cache exceeds MAX_ENTRIES.
 */

interface CachedThumbnail {
  micro: string | null;
  full: string | null;
}

const MAX_ENTRIES = 500;

// Keyed by reloadKey: `${path}:${backendSize}:${quality}`
const cache = new Map<string, CachedThumbnail>();

function isBlobUrl(url: string | null): boolean {
  return url !== null && url.startsWith("blob:");
}

function revokeEntry(entry: CachedThumbnail): void {
  if (isBlobUrl(entry.micro)) URL.revokeObjectURL(entry.micro!);
  if (isBlobUrl(entry.full)) URL.revokeObjectURL(entry.full!);
}

export function getThumbnailCache(key: string): CachedThumbnail | undefined {
  const entry = cache.get(key);
  if (entry !== undefined) {
    // Refresh recency: move to the end of the Map's insertion order.
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

export function setThumbnailCache(key: string, value: CachedThumbnail): void {
  const existing = cache.get(key);
  if (existing) {
    revokeEntry(existing);
    cache.delete(key);
  }
  cache.set(key, value);

  if (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = cache.get(oldestKey)!;
      cache.delete(oldestKey);
      revokeEntry(oldest);
    }
  }
}

/**
 * Re-key cached thumbnails after a rename. Matches both the renamed entry
 * itself (`oldPath:...`) and, for directory renames, everything beneath it
 * (`oldPath/child:...`).
 */
export function renameThumbnailCache(oldPath: string, newPath: string): void {
  for (const [key, value] of [...cache]) {
    if (key.startsWith(oldPath + ":") || key.startsWith(oldPath + "/")) {
      const newKey = newPath + key.slice(oldPath.length);
      cache.delete(key);
      cache.set(newKey, value);
    }
  }
}
