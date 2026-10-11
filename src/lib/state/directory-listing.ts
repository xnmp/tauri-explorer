/** Latest-request ownership for complete directory snapshots and watch leases. */
import { loadDirectory, type DirectoryWatchLease, type ListingTrace } from "$lib/api/files";
import { extractError } from "$lib/api/common";
import type { FileEntry } from "$lib/domain/file";
import type { QueuedBehind } from "$lib/domain/load-diagnostics";
import { loadWatchdog } from "./load-watchdog";

/** A traced navigation also learns which listing it is queued behind. */
export interface DirectoryListingTrace extends ListingTrace {
  queuedBehind?(blocker: QueuedBehind | null): void;
}

export type DirectoryListingResult = {
  ok: true;
  path: string;
  entries: FileEntry[];
} | {
  ok: false;
  error: string;
  /** Supersession/teardown is not a filesystem failure or a reason to navigate away. */
  cancelled?: true;
};

export interface DirectoryObservation {
  ready: Promise<void>;
  current?(): boolean;
  accept(lease: DirectoryWatchLease | null): boolean;
  discard(lease: DirectoryWatchLease): void;
}

export function createDirectoryListing(deps: {
  now?: () => number;
  /** Trace ID for an untraced (refresh) listing, so its native phases can
   *  explain a navigation queued behind it. */
  mintTraceId?: () => string;
} = {}) {
  const now = deps.now ?? (() => performance.now());
  const mintTraceId = deps.mintTraceId ?? (() => loadWatchdog.mintTraceId());
  let destroyed = false;
  let generation = 0;
  // The scan currently holding the queue (#1022): a stuck refresh is a
  // common reason a later navigation shows "Loading..." indefinitely.
  let running: QueuedBehind | null = null;
  // Keep one scan per owner in flight. A newer request invalidates older queued
  // requests immediately, so they can be skipped without starting more disk IO.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }
  const cancelled = (): DirectoryListingResult => ({
    ok: false,
    cancelled: true,
    error: destroyed ? "Directory listing has been destroyed" : "Directory navigation was superseded",
  });

  async function read(
    path: string,
    request: number,
    observation: DirectoryObservation | undefined,
    trace: ListingTrace,
  ): Promise<DirectoryListingResult> {
    const current = () => !destroyed && request === generation && (observation?.current?.() ?? true);
    if (!current()) return cancelled();
    try {
      if (observation) trace.phase("watch-ready");
      await observation?.ready;
    } catch (error) {
      return current() ? { ok: false, error: extractError(error) } : cancelled();
    }
    if (!current()) return cancelled();
    const result = await loadDirectory(path, observation, trace);
    if (!current() || (result.ok && observation && !observation.accept(result.data.watch_lease ?? null))) {
      if (result.ok && result.data.watch_lease) observation?.discard(result.data.watch_lease);
      return cancelled();
    }
    return result.ok
      ? { ok: true, path: result.data.path, entries: [...result.data.entries] }
      : result;
  }

  return {
    load: (path: string, observation?: DirectoryObservation, trace?: DirectoryListingTrace) => {
      const request = ++generation;
      const listingTrace: ListingTrace = trace ?? { id: mintTraceId(), watched: false, phase: () => {} };
      trace?.phase("queued");
      trace?.queuedBehind?.(running);
      return enqueue(async () => {
        running = { path, reason: trace ? "navigation" : "refresh", startedMono: now(), traceId: listingTrace.id };
        try {
          return await read(path, request, observation, listingTrace);
        } finally {
          running = null;
        }
      });
    },
    cleanup: () => {
      destroyed = true;
      generation++;
      // Wait for any late response to release its observation lease.
      return enqueue(async () => {});
    },
  };
}
