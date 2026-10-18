/**
 * Thumbnail loads, shared by cache key (#136, #247, #593; #1241 review).
 *
 * A tile watches the load for its key; the load itself belongs to this module,
 * not to the tile. A tile that unmounts mid-request (a virtual-list rechunk, a
 * closed Tiles panel, a fast scroll) therefore does not lose the response: it is
 * published to the shared LRU cache, and a remount (or another tile with the
 * same key) joins the load in flight instead of asking again. Every blob URL a
 * response creates ends in the cache; none is dropped.
 *
 * Pacing is unchanged. Two pools bound concurrency (micro 8, full 4; keep
 * requests per item, #593), and queued work starts only while a watcher is on
 * screen, so a fast scroll does not decode every tile it crossed (#136). Once a
 * micro thumbnail has arrived, its full thumbnail is fetched even with no
 * watcher left: it is usually a pre-warmed backend cache hit, and the result is
 * what a remount paints.
 */
import type { ApiResult } from "$lib/api/common";
import { getThumbnailCache, setThumbnailCache, type CachedThumbnail } from "./thumbnail-cache";

export interface ThumbnailRequests {
  /** Progressive images fetch a micro thumbnail first; video frames are single-shot. */
  readonly micro?: () => Promise<ApiResult<string>>;
  readonly full: () => Promise<ApiResult<string>>;
}

/** What a watcher shows. */
export interface ThumbnailState {
  readonly micro: string | null;
  readonly full: string | null;
  /** Why nothing could be shown (every request failed). */
  readonly error: string | null;
  /** Nothing more will arrive. */
  readonly settled: boolean;
  /** From the cache: the full image is already in memory, so no cross-fade (#259). */
  readonly cached: boolean;
}

export interface ThumbnailWatcher {
  /** The tile's last known viewport membership. */
  visible(): boolean;
  update(state: ThumbnailState): void;
}

export interface ThumbnailPool {
  acquire(): Promise<void>;
  release(): void;
}

export function createPool(max: number): ThumbnailPool {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    acquire() {
      if (active < max) { active++; return Promise.resolve(); }
      return new Promise(resolve => queue.push(() => { active++; resolve(); }));
    },
    release() {
      active--;
      queue.shift()?.();
    },
  };
}

interface Flight {
  readonly key: string;
  readonly requests: ThumbnailRequests;
  readonly watchers: Set<ThumbnailWatcher>;
  state: ThumbnailState;
}

export interface ThumbnailLoadsDeps {
  readonly pools: { readonly micro: ThumbnailPool; readonly full: ThumbnailPool };
  readonly cache: { get(key: string): CachedThumbnail | undefined; set(key: string, value: CachedThumbnail): void };
}

const pending: ThumbnailState = { micro: null, full: null, error: null, settled: false, cached: false };

async function attempt(request: () => Promise<ApiResult<string>>): Promise<ApiResult<string>> {
  try {
    return await request();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function createThumbnailLoads(deps: ThumbnailLoadsDeps) {
  const flights = new Map<string, Flight>();

  const wanted = (flight: Flight) => [...flight.watchers].some(watcher => watcher.visible());
  function publish(flight: Flight, state: ThumbnailState): void {
    flight.state = state;
    for (const watcher of [...flight.watchers]) watcher.update(state);
  }

  async function run(flight: Flight): Promise<void> {
    let micro: string | null = null;
    let full: string | null = null;
    let error: string | null = null;
    try {
      if (flight.requests.micro) {
        await deps.pools.micro.acquire();
        try {
          if (!wanted(flight)) return;
          const result = await attempt(flight.requests.micro);
          if (result.ok) {
            micro = result.data;
            publish(flight, { ...pending, micro });
          } else error = result.error;
        } finally {
          deps.pools.micro.release();
        }
      }
      await deps.pools.full.acquire();
      try {
        if (!micro && !wanted(flight)) return;
        const result = await attempt(flight.requests.full);
        if (result.ok) { full = result.data; error = null; } else if (!micro) error = result.error;
      } finally {
        deps.pools.full.release();
      }
      if (micro || full) deps.cache.set(flight.key, { micro, full });
      flights.delete(flight.key);
      publish(flight, { micro, full, error: micro || full ? null : error, settled: true, cached: false });
    } finally {
      // An abandoned load (no watcher on screen when its slot came) leaves
      // nothing behind: the next watcher starts afresh.
      if (flights.get(flight.key) === flight) flights.delete(flight.key);
    }
  }

  return {
    /**
     * Watch the load for `key`: a cached full thumbnail at once, else the load
     * in flight (joined) or a new one. `update` runs synchronously with the
     * current state, then as results arrive. Returns the unsubscribe; call it
     * when the tile unmounts, leaves the screen or changes key.
     */
    watch(key: string, requests: ThumbnailRequests, watcher: ThumbnailWatcher): () => void {
      const hit = deps.cache.get(key);
      if (hit?.full) {
        watcher.update({ micro: hit.micro, full: hit.full, error: null, settled: true, cached: true });
        return () => {};
      }
      let flight = flights.get(key);
      const started = !flight;
      if (!flight) {
        flight = { key, requests, watchers: new Set(), state: pending };
        flights.set(key, flight);
      }
      const joined = flight;
      joined.watchers.add(watcher);
      watcher.update(joined.state);
      if (started) void run(joined);
      return () => { joined.watchers.delete(watcher); };
    },
    /** Loads in flight (tests and diagnostics). */
    get inFlight(): number { return flights.size; },
  };
}

export const thumbnailLoads = createThumbnailLoads({
  pools: { micro: createPool(8), full: createPool(4) },
  cache: { get: getThumbnailCache, set: setThumbnailCache },
});
