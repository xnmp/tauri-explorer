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
}

export function createDirectoryListing() {
  let activeListingId: number | null = null;
  let unlisten: UnlistenFn | null = null;

  async function cleanup() {
    if (activeListingId !== null) {
      await cancelDirectoryListing(activeListingId);
      activeListingId = null;
    }
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  async function setupListener(
    listingId: number,
    expectedPath: string,
    callbacks: DirectoryListingCallbacks,
  ) {
    if (unlisten) unlisten();

    unlisten = await listen<DirectoryEntriesEvent>("directory-entries", (event) => {
      const payload = event.payload;
      if (payload.listingId !== listingId || activeListingId !== listingId) return;
      if (payload.path !== expectedPath) return;

      callbacks.onEntries(payload.entries);

      if (payload.done) {
        callbacks.onDone();
        activeListingId = null;
      }
    });
  }

  async function load(
    path: string,
    callbacks: DirectoryListingCallbacks,
  ): Promise<DirectoryListingResult> {
    await cleanup();

    const result = await startStreamingDirectory(path);

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const listingId = result.data.listing_id;

    if (listingId !== null) {
      activeListingId = listingId;
      await setupListener(listingId, result.data.path, callbacks);
    }

    return {
      ok: true,
      path: result.data.path,
      entries: [...result.data.entries],
      streaming: listingId !== null,
    };
  }

  return { load, cleanup };
}
