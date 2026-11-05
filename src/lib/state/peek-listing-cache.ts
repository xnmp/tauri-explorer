/** Bounded, window-wide memory of the last complete listing each Folder Peek
 * published (#1509), so re-opening or re-hovering a peek paints at once.
 *
 * This is a paint source, never a freshness authority: a closed peek holds no
 * watch, so its folder can change unobserved. The session still issues the
 * peek's first read through pane-watch/pane-refresh (the existing WHEN/WHETHER/
 * HOW split) and reconciles it against these entries, keeping identities when
 * nothing changed. Shared directory-change notifications and local mutation
 * broadcasts evict an entry, so a change this window has seen never paints. */
import type { FileEntry } from "$lib/domain/file";
import { pathComparison } from "$lib/domain/path";
import { isWindows } from "$lib/domain/platform";
import { directoryEvents } from "./directory-events";
import { subscribeToLocalFileChanges } from "./file-events";

export interface PeekListingCacheOptions {
  windows: boolean;
  /** Most directories remembered (least recently used leave first). */
  maxDirectories?: number;
  /** Total remembered entries across directories (#1416 large-folder memory). */
  maxEntries?: number;
  /** Listings larger than this are never remembered. */
  maxListing?: number;
}

export function createPeekListingCache(options: PeekListingCacheOptions) {
  const { key } = pathComparison(options.windows);
  const maxDirectories = options.maxDirectories ?? 32;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxListing = options.maxListing ?? 5_000;
  const listings = new Map<string, readonly FileEntry[]>();
  let total = 0;
  function remove(id: string) {
    const entries = listings.get(id);
    if (!entries) return;
    listings.delete(id);
    total -= entries.length;
  }
  return {
    get(path: string): readonly FileEntry[] | undefined {
      const id = key(path);
      const entries = id === null ? undefined : listings.get(id);
      if (!entries || id === null) return undefined;
      listings.delete(id); listings.set(id, entries);
      return entries;
    },
    /** Remember a complete listing a live peek published. */
    put(path: string, entries: readonly FileEntry[]) {
      const id = key(path);
      if (id === null) return;
      remove(id);
      if (entries.length > maxListing) return;
      listings.set(id, entries);
      total += entries.length;
      for (const oldest of listings.keys()) {
        if (listings.size <= maxDirectories && total <= maxEntries) break;
        remove(oldest);
      }
    },
    /** A directory changed: its remembered listing may no longer be true. */
    invalidate(paths: Iterable<string>) {
      for (const path of paths) { const id = key(path); if (id !== null) remove(id); }
    },
    clear() { listings.clear(); total = 0; },
    get size() { return listings.size; },
    get totalEntries() { return total; },
  };
}

export type PeekListingCache = ReturnType<typeof createPeekListingCache>;

let shared: PeekListingCache | undefined;
/** The window's cache, subscribed to the shared change streams on first use.
 * Loaded only with the lazy peek session, outside the startup bundle. */
export function peekListingCache(): PeekListingCache {
  if (shared) return shared;
  const cache = createPeekListingCache({ windows: isWindows });
  shared = cache;
  subscribeToLocalFileChanges(dirs => cache.invalidate(dirs));
  const subscription = directoryEvents.subscribe(change => cache.invalidate([change.path]));
  // Pane observation owns listener recovery; the read-on-open covers misses.
  void subscription.ready().catch(() => {});
  return cache;
}
