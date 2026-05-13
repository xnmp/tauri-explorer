/**
 * Frontend thumbnail blob URL cache.
 * Survives renames without requiring backend re-generation.
 * Revokes old blob URLs on replacement to prevent memory leaks.
 */

interface CachedThumbnail {
  micro: string | null;
  full: string | null;
}

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
  return cache.get(key);
}

export function setThumbnailCache(key: string, value: CachedThumbnail): void {
  const existing = cache.get(key);
  if (existing) revokeEntry(existing);
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
