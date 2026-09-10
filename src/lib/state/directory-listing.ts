/**
 * Streaming directory listing management.
 * Handles Tauri event-based incremental directory loading.
 * Extracted from explorer.svelte.ts.
 */

import { startStreamingDirectory, cancelDirectoryListing, type DirectoryEntriesEvent, type DirectoryWatchLease } from "$lib/api/files";
import { extractError, isTauri } from "$lib/api/common";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FileEntry } from "$lib/domain/file";

const DESTROYED_ERROR = "Directory listing has been destroyed";

export type DirectoryListingResult = {
  ok: true;
  path: string;
  entries: FileEntry[];
  streaming: boolean;
} | {
  ok: false;
  error: string;
}

export interface DirectoryListingCallbacks {
  onEntries: (entries: FileEntry[]) => void;
  onDone: () => void;
  /** Invoked when the listing is cancelled before completing (superseded by
   *  a newer load or torn down via cleanup). Lets awaiting callers bail out. */
  onCancelled?: () => void;
}

export interface DirectoryObservation {
  ready: Promise<void>;
  current?(): boolean;
  accept(lease: DirectoryWatchLease | null): boolean;
  discard(lease: DirectoryWatchLease): void;
}

export function createDirectoryListing() {
  let activeListingId: number | null = null;
  let activeCallbacks: DirectoryListingCallbacks | null = null;
  let destroyed = false;

  // Single persistent `directory-entries` listener, registered once and reused
  // across every load. Previously each load did `await listen(...)` before
  // invoking — a second IPC round-trip paid on EVERY navigation before entries
  // could arrive. Registering once removes that hop from all subsequent loads;
  // kicking registration off at creation time (below) means even the first
  // navigation usually finds it already attached.
  let unlisten: UnlistenFn | null = null;
  let listenerReady: Promise<void> | null = null;

  // While a load has sent its invoke but not yet learned its listing id, events
  // are buffered here (the backend emits as soon as the command runs, so a
  // chunk can land before `startStreamingDirectory` resolves). Loads are
  // serialized by `enqueue`, so at most one load owns this buffer at a time.
  let awaitingListingId = false;
  let earlyBuffer: DirectoryEntriesEvent[] = [];

  // Serializes load/cleanup critical sections. A load's setup spans several
  // awaits (cancel previous, ensure listener, invoke); a concurrent load
  // (e.g. navigation during an in-flight refresh) interleaving with it would
  // corrupt the shared early-buffer / active-listing state.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const handleEvent = (payload: DirectoryEntriesEvent) => {
    if (destroyed) return;
    // A load is mid-flight and hasn't recorded its id yet — buffer and let
    // doLoad flush the ones matching its id once the invoke resolves.
    if (awaitingListingId) {
      earlyBuffer.push(payload);
      return;
    }
    // Ignore events from superseded/cancelled listings.
    if (payload.listingId !== activeListingId) return;
    activeCallbacks?.onEntries(payload.entries);
    // An entry callback can synchronously tear down its owner.
    if (destroyed) return;
    if (payload.done) {
      activeListingId = null;
      const cb = activeCallbacks;
      activeCallbacks = null;
      cb?.onDone();
    }
  };

  // Register the persistent listener once. A rejected native registration
  // stays attached to the first load that observes it; that load fails before
  // starting a stream, then clears the attempt so a later load can retry.
  function ensureListener(): Promise<void> {
    if (listenerReady) return listenerReady;
    if (destroyed) return Promise.reject(new Error(DESTROYED_ERROR));

    const pending = listen<DirectoryEntriesEvent>("directory-entries", (event) =>
      handleEvent(event.payload),
    ).then((un) => {
      // cleanup() seals the instance synchronously. If registration finishes
      // after that point, release the late resource instead of publishing it
      // into an already-destroyed owner.
      if (destroyed) {
        un();
        throw new Error(DESTROYED_ERROR);
      }
      unlisten = un;
    });
    listenerReady = pending;
    return listenerReady;
  }

  /** Cancel the in-flight listing and clear its callbacks, keeping the
   *  persistent listener attached. Run at the start of each load. */
  async function cancelActive() {
    const cancelled = activeCallbacks;
    activeCallbacks = null;
    if (activeListingId !== null) {
      await cancelDirectoryListing(activeListingId);
      activeListingId = null;
    }
    cancelled?.onCancelled?.();
  }

  async function doLoad(
    path: string,
    callbacks: DirectoryListingCallbacks,
    observation?: DirectoryObservation,
  ): Promise<DirectoryListingResult> {
    if (destroyed) return { ok: false, error: DESTROYED_ERROR };
    await cancelActive();

    const ready = ensureListener();
    try {
      await ready;
    } catch (error) {
      if (listenerReady === ready) listenerReady = null;
      if (destroyed) return { ok: false, error: DESTROYED_ERROR };

      // Browser/mock listings are returned inline and cannot stream. Retain
      // that existing fallback while refusing to invoke the native streaming
      // command unless its receiving listener is ready.
      if (!isTauri()) {
        listenerReady = Promise.resolve();
      } else {
        return { ok: false, error: extractError(error) };
      }
    }

    try {
      await observation?.ready;
    } catch (error) {
      return { ok: false, error: extractError(error) };
    }
    if (destroyed) return { ok: false, error: DESTROYED_ERROR };
    if (observation?.current && !observation.current()) {
      return { ok: false, error: "Directory navigation was superseded" };
    }

    awaitingListingId = true;
    earlyBuffer.length = 0;

    const result = await startStreamingDirectory(path, observation);

    // cleanup() can seal this owner while the start IPC is pending. Discard
    // both inline data and buffered events in that case. A backend stream was
    // already created before its id reached us, so retire it here; doDestroy
    // cannot see an id that was never published as active.
    if (destroyed || (result.ok && observation && !observation.accept(result.data.watch_lease ?? null))) {
      if (result.ok && result.data.watch_lease) observation?.discard(result.data.watch_lease);
      awaitingListingId = false;
      earlyBuffer.length = 0;
      if (result.ok && result.data.listing_id !== null) {
        await cancelDirectoryListing(result.data.listing_id);
      }
      return { ok: false, error: destroyed ? DESTROYED_ERROR : "Directory navigation was superseded" };
    }

    if (!result.ok) {
      awaitingListingId = false;
      return { ok: false, error: result.error };
    }

    const listingId = result.data.listing_id;

    if (listingId === null) {
      // Small directory (or mock mode): complete listing was in the invoke result.
      awaitingListingId = false;
      earlyBuffer.length = 0;
      return {
        ok: true,
        path: result.data.path,
        entries: [...result.data.entries],
        streaming: false,
      };
    }

    // Merge chunks that streamed in before the invoke resolved into the
    // returned entries (callers assign the result wholesale, so emitting
    // them through onEntries here would get overwritten by that assignment).
    // Events arriving after this point are delivered via handleEvent.
    const flushedEntries: FileEntry[] = [];
    let doneSeen = false;
    for (const payload of earlyBuffer) {
      if (payload.listingId !== listingId) continue;
      flushedEntries.push(...payload.entries);
      if (payload.done) doneSeen = true;
    }
    earlyBuffer.length = 0;
    awaitingListingId = false;

    if (!doneSeen) {
      activeListingId = listingId;
      activeCallbacks = callbacks;
    }

    return {
      ok: true,
      path: result.data.path,
      entries: [...result.data.entries, ...flushedEntries],
      streaming: !doneSeen,
    };
  }

  /** Full teardown for instance destroy: cancel in-flight listing and remove
   *  the persistent listener. */
  async function doDestroy() {
    await cancelActive();
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    listenerReady = null;
  }

  // Start registering the listener immediately (not awaited). Store/window
  // init and the first navigateTo happen after this, so the listen() promise
  // has usually resolved by the first load — making even the first navigation
  // skip the round-trip.
  void ensureListener().catch(() => {
    // The first load observes the cached failure and owns retry publication.
  });

  return {
    load: (path: string, callbacks: DirectoryListingCallbacks, observation?: DirectoryObservation) =>
      enqueue(() => doLoad(path, callbacks, observation)),
    cleanup: () => {
      destroyed = true;
      return enqueue(() => doDestroy());
    },
  };
}
