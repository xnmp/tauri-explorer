/**
 * Which window tabs keep their rendered pane tree while hidden (#1173).
 *
 * Remounting a tab rebuilds its pane chrome and every visible row, which is
 * the whole cost of a tab switch. Recently active tabs therefore stay mounted
 * (hidden) up to a fixed capacity, so switching back only toggles visibility.
 *
 * `mounted` is the render order and stays stable for retained tabs: reordering
 * keyed DOM would move the subtrees, and a moved scroller loses its offset.
 * `recent` is most-recently-active first and decides eviction.
 */
export interface RetainedTabs<K> {
  readonly mounted: readonly K[];
  readonly recent: readonly K[];
}

/** Active tab plus the previously visited ones kept warm for switching back. */
export const RETAINED_TAB_CAPACITY = 4;

export function emptyRetainedTabs<K>(): RetainedTabs<K> {
  return { mounted: [], recent: [] };
}

export function retainTabs<K>(
  previous: RetainedTabs<K>,
  active: K | null,
  isLive: (key: K) => boolean,
  capacity: number = RETAINED_TAB_CAPACITY,
): RetainedTabs<K> {
  const recent = (active === null ? previous.recent : [active, ...previous.recent.filter((key) => key !== active)])
    .filter(isLive)
    .slice(0, Math.max(1, capacity));
  const kept = previous.mounted.filter((key) => recent.includes(key));
  const mounted = active !== null && recent.includes(active) && !kept.includes(active) ? [...kept, active] : kept;
  return { mounted, recent };
}
