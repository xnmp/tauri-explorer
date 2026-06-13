/**
 * Streaming directory listing management.
 * Handles Tauri event-based incremental directory loading.
 * Extracted from explorer.svelte.ts.
 */

import {
  startStreamingDirectory,
  cancelDirectoryListing,
  type DirectoryEntriesEvent,
} from "$lib/api/files";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FileEntry } from "$lib/domain/file";

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

export function createDirectoryListing() {
  let activeListingId: number | null = null;
  let unlisten: UnlistenFn | null = null;
  let activeCallbacks: DirectoryListingCallbacks | null = null;

  // Serializes load/cleanup critical sections. A load's setup spans several
  // awaits (cancel previous, attach listener, invoke); a concurrent load
  // (e.g. navigation during an in-flight refresh) interleaving with it would
  // overwrite `unlisten` (leaking the first listener) and leave the first
  // listing running without ever notifying its callbacks.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function teardownListener() {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  async function doCleanup() {
    const cancelled = activeCallbacks;
    activeCallbacks = null;
    if (activeListingId !== null) {
      await cancelDirectoryListing(activeListingId);
      activeListingId = null;
    }
    teardownListener();
    cancelled?.onCancelled?.();
  }

  async function doLoad(
    path: string,
    callbacks: DirectoryListingCallbacks,
  ): Promise<DirectoryListingResult> {
    await doCleanup();

    // Register the listener BEFORE invoking: the backend starts emitting
    // `directory-entries` events as soon as the command runs, so a listener
    // attached after the invoke resolves can miss early chunks or the done
    // event (missing entries / stuck spinner). Events arriving before we
    // know our listing id are buffered, then flushed filtered by id.
    // Same pattern as the search listener in QuickOpen.svelte.
    let listingId: number | null = null;
    const buffered: DirectoryEntriesEvent[] = [];

    const handleEvent = (payload: DirectoryEntriesEvent) => {
      if (payload.listingId !== activeListingId) return;
      callbacks.onEntries(payload.entries);
      if (payload.done) {
        activeListingId = null;
        activeCallbacks = null;
        callbacks.onDone();
      }
    };

    // Outside Tauri (browser/mock mode) the event system is unavailable and
    // listen() rejects; the mock returns the complete listing in the invoke
    // result (listing_id null), so we can proceed without a listener.
    try {
      unlisten = await listen<DirectoryEntriesEvent>("directory-entries", (event) => {
        if (listingId === null) {
          buffered.push(event.payload);
          return;
        }
        handleEvent(event.payload);
      });
    } catch {
      unlisten = null;
    }

    const result = await startStreamingDirectory(path);

    if (!result.ok) {
      teardownListener();
      return { ok: false, error: result.error };
    }

    listingId = result.data.listing_id;

    if (listingId === null) {
      // Small directory: complete listing was in the invoke result.
      teardownListener();
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
    for (const payload of buffered) {
      if (payload.listingId !== listingId) continue;
      flushedEntries.push(...payload.entries);
      if (payload.done) doneSeen = true;
    }
    buffered.length = 0;

    if (doneSeen) {
      teardownListener();
    } else {
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

  return {
    load: (path: string, callbacks: DirectoryListingCallbacks) =>
      enqueue(() => doLoad(path, callbacks)),
    cleanup: () => enqueue(() => doCleanup()),
  };
}
