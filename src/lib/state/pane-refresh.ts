/**
 * Per-pane refresh: re-list the current directory without flashing the UI
 * when nothing changed. Extracted from explorer.svelte.ts.
 *
 * Invariants preserved from the original implementation:
 * - streamed chunks are accumulated (for >100-entry directories the invoke
 *   result only contains the first batch, the rest arrives via events)
 * - the result is discarded if the pane navigated away mid-fetch
 *   (path-change bail) or the listing was cancelled by a newer load
 * - watcher-triggered (silent) refreshes are skipped during the
 *   local-mutation cooldown so thumbnails don't flash after rename/delete
 */

import type { FileEntry } from "$lib/domain/file";
import type { ExplorerCoreState } from "./types";
import type { createDirectoryListing } from "./directory-listing";
import { toastStore } from "./toast.svelte";

export interface PaneRefreshContext {
  coreState: ExplorerCoreState;
  dirListing: ReturnType<typeof createDirectoryListing>;
  inMutationCooldown: () => boolean;
  updateWatch: (path: string) => void;
  /** Fallback when the current directory no longer exists. */
  navigateToParent: () => Promise<void>;
}

/** Build a fingerprint string for change detection. */
export function entriesFingerprint(entries: FileEntry[]): string {
  return entries.map((e) => `${e.path}\0${e.size}\0${e.modified}`).join("\n");
}

export function createPaneRefresh(ctx: PaneRefreshContext) {
  const { coreState, dirListing } = ctx;

  return async function refresh(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent ?? false;

    if (silent && ctx.inMutationCooldown()) {
      return;
    }

    const refreshPath = coreState.currentPath;
    const oldFingerprint = entriesFingerprint(coreState.entries);

    // Fetch new data without touching UI state — avoids flash on no-change.
    let streamedEntries: FileEntry[] = [];
    let cancelled = false;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const result = await dirListing.load(refreshPath, {
      onEntries: (entries) => {
        streamedEntries = [...streamedEntries, ...entries];
      },
      onDone: () => resolveDone(),
      onCancelled: () => {
        cancelled = true;
        resolveDone();
      },
    });

    if (!result.ok) {
      // The pane navigated away while the fetch was in flight — not our call.
      if (coreState.currentPath !== refreshPath) return;
      // Directory no longer exists — fall back to parent
      await ctx.navigateToParent();
      return;
    }

    if (result.streaming) await donePromise;

    // Bail if superseded: a navigation cancelled the listing or changed path.
    if (cancelled || coreState.currentPath !== refreshPath) return;

    // We now hold a complete listing for the pane's current path. If this
    // refresh interrupted a still-streaming navigation to the same path
    // (cancelling its onDone), clear the spinner it left behind.
    coreState.loading = false;

    const allEntries = [...result.entries, ...streamedEntries];
    const newFingerprint = entriesFingerprint(allEntries);
    // Compare against both the pre-fetch snapshot and the current entries.
    // A local mutation may have updated entries while the fetch was in flight
    // (inotify on Linux fires before the IPC response returns).
    const currentFingerprint = entriesFingerprint(coreState.entries);
    if (oldFingerprint === newFingerprint || currentFingerprint === newFingerprint) {
      if (!silent) {
        toastStore.show("Already up to date", "info", { duration: 1500 });
      }
      return;
    }

    coreState.entries = allEntries;
    ctx.updateWatch(result.path);

    if (!silent) {
      toastStore.show("Refreshed", "info", { duration: 1500 });
    }
  };
}
