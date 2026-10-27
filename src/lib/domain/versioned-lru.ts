/**
 * A bounded least-recently-used cache holding one version per key (#1418).
 *
 * The Markdown preview keeps the rendered blocks of documents it showed, keyed
 * by path and versioned by mtime, size and local preview revision, so going
 * back to a file skips its read and typesetting. A lookup with any other
 * version misses, and storing a version drops the key's older one: a changed
 * file is never served stale. Bounded by entry count and by total weight; the
 * most recently stored or used entry is never evicted, even when it alone
 * exceeds the weight budget.
 */

export interface VersionedLruLimits {
  readonly maxEntries: number;
  readonly maxWeight: number;
}

export interface VersionedLru<V> {
  /** The value stored for exactly this version, now most recent; or undefined. */
  get(key: string, version: string): V | undefined;
  set(key: string, version: string, value: V): void;
  clear(): void;
  readonly size: number;
}

export function createVersionedLru<V>(limits: VersionedLruLimits, weigh: (value: V) => number): VersionedLru<V> {
  // Map iteration order is insertion order: re-inserting marks an entry most recent.
  const entries = new Map<string, { version: string; value: V; weight: number }>();
  let totalWeight = 0;

  function remove(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalWeight -= entry.weight;
  }

  return {
    get(key, version) {
      const entry = entries.get(key);
      if (!entry || entry.version !== version) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, version, value) {
      remove(key);
      const weight = weigh(value);
      entries.set(key, { version, value, weight });
      totalWeight += weight;
      for (const oldest of entries.keys()) {
        if (entries.size <= 1 || (entries.size <= limits.maxEntries && totalWeight <= limits.maxWeight)) break;
        remove(oldest);
      }
    },
    clear() {
      entries.clear();
      totalWeight = 0;
    },
    get size() {
      return entries.size;
    },
  };
}
