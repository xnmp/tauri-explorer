/**
 * Frontend thumbnail blob URL cache.
 * Survives renames without requiring backend re-generation.
 * Revokes old blob URLs on replacement to prevent memory leaks.
 *
 * Bounded LRU: the Map's insertion order tracks recency (gets re-insert),
 * and the least-recently-used entry is evicted (with its blob URLs revoked)
 * once the cache exceeds MAX_ENTRIES.
 */

export interface CachedThumbnail {
  micro: string | null;
  full: string | null;
}

const MAX_ENTRIES = 500;

// Keyed by `thumbnailCacheKey`: `${kind}:${path}:${backendSize}:${quality}@${version}`
const cache = new Map<string, CachedThumbnail>();

function isBlobUrl(url: string | null): boolean {
  return url !== null && url.startsWith("blob:");
}

function revokeEntry(entry: CachedThumbnail): void {
  if (isBlobUrl(entry.micro)) URL.revokeObjectURL(entry.micro!);
  if (isBlobUrl(entry.full)) URL.revokeObjectURL(entry.full!);
}

/**
 * The content version of a file, as the backend's disk cache keys it: its
 * modification time and byte length (#1937). It contains no `:`, so a key's
 * path still parses. A different version means different pixels.
 */
export function thumbnailVersion(entry: { readonly modified: string; readonly size: number }): string {
  const time = Date.parse(entry.modified);
  const modified = Number.isNaN(time) ? entry.modified.replaceAll(":", "") : String(time);
  return `${modified}.${entry.size}`;
}

/**
 * The cache (and load) key of one thumbnail. The content version is a suffix of
 * the last segment, so editing a file gives its thumbnail a new key: no
 * invalidation path is needed for watcher-seen edits, overwrites or re-exports
 * (#1937). Without a version the key has the older four-part shape.
 */
export function thumbnailCacheKey(
  kind: string, path: string, backendSize: number, quality: number | undefined, version?: string,
): string {
  const base = `${kind}:${path}:${backendSize}:${quality}`;
  return version === undefined ? base : `${base}@${version}`;
}

/** A key without its `@version` suffix, or null when it carries none. */
function unversioned(key: string): string | null {
  const at = key.indexOf("@", key.lastIndexOf(":") + 1);
  return at < 0 ? null : key.slice(0, at);
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
  // An older version of the same thumbnail will never be asked for again: its
  // file changed. Drop it now instead of waiting for LRU eviction (#1937).
  const base = unversioned(key);
  if (base !== null) {
    for (const [other, stale] of [...cache]) {
      if (other !== key && unversioned(other) === base) { cache.delete(other); revokeEntry(stale); }
    }
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
 * itself and, for directory renames, everything beneath it
 * (`oldPath/child`), by the key path segment.
 */
export function renameThumbnailCache(oldPath: string, newPath: string): void {
  // The pixels are unchanged, so subscribers are not told: not an invalidation.
  for (const [key, value] of [...cache]) {
    const path = keyPath(key);
    if (path === null) continue;
    if (path !== oldPath && !path.startsWith(oldPath + "/") && !path.startsWith(oldPath + "\\")) continue;
    const start = key.indexOf(":") + 1;
    const newKey = key.slice(0, start) + newPath + path.slice(oldPath.length) + key.slice(start + path.length);
    cache.delete(key);
    const displaced = cache.get(newKey);
    if (displaced && displaced !== value) revokeEntry(displaced);
    cache.set(newKey, value);
  }
}

/**
 * The file path a cache key names. Keys are `${kind}:${path}:${backendSize}:${quality}`,
 * optionally followed by `@${version}` (`thumbnailCacheKey`); the path may itself contain `:` (a Windows drive),
 * so the kind is the segment before the first `:` and size and quality are the
 * two after the last ones. Null for a key of any other shape.
 */
function keyPath(key: string): string | null {
  const first = key.indexOf(":");
  const quality = key.lastIndexOf(":");
  const size = quality > first ? key.lastIndexOf(":", quality - 1) : -1;
  return first > 0 && size > first ? key.slice(first + 1, size) : null;
}

type InvalidationListener = (path: string) => void;
const invalidationListeners = new Set<InvalidationListener>();

/** Be told when `invalidateThumbnailCache` dropped a path's thumbnails, so a
 * tile still showing (or about to reuse) the old pixels can load again. */
export function subscribeThumbnailInvalidation(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/** A generated replacement can retain its path, byte count and timestamp
 * precision. Drop every cached kind, size and quality of `path` instead of
 * reusing its old pixels, revoking their blob URLs (#1267). */
export function invalidateThumbnailCache(path: string): void {
  for (const [key, value] of [...cache]) {
    if (keyPath(key) === path) { cache.delete(key); revokeEntry(value); }
  }
  for (const listener of [...invalidationListeners]) listener(path);
}
