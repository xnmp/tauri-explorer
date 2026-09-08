/**
 * Per-pane refresh: re-list the current directory without flashing the UI
 * when nothing changed. Extracted from explorer.svelte.ts.
 *
 * Invariants preserved from the original implementation:
 * - streamed chunks are accumulated (for >100-entry directories the invoke
 *   result only contains the first batch, the rest arrives via events)
 * - the result is discarded if the pane navigated away mid-fetch
 *   (path-change bail) or the listing was cancelled by a newer load
 * - unchanged listings do not publish, including watcher echoes of local work
 */

import type { FileEntry } from "$lib/domain/file";
import { reconcileDirectoryEntries, reconcileDirectorySelection } from "$lib/domain/directory-reconciliation";
import type { ExplorerCoreState } from "./types";
import type { createDirectoryListing } from "./directory-listing";
import { toastStore } from "./toast.svelte";

export interface PaneRefreshContext {
  coreState: ExplorerCoreState;
  dirListing: ReturnType<typeof createDirectoryListing>;
  allowRefresh: (path: string) => boolean;
  setSelection: (next: Iterable<string>) => void;
  /** Schedule a fresh observation through the existing WHEN/WHETHER owners. */
  requestReconcile: (path: string) => void;
  /** Fallback when the current directory no longer exists. */
  navigateToParent: () => Promise<void>;
}

export function createPaneRefresh(ctx: PaneRefreshContext) {
  const { coreState, dirListing } = ctx;

  return async function refresh(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent ?? false;
    const refreshPath = coreState.currentPath;
    if (!ctx.allowRefresh(refreshPath)) return;
    const oldEntries = coreState.entries;
    const oldSelection = {
      selectedPaths: new Set(coreState.selectedPaths),
      cursorPath: coreState.cursorPath,
      anchorPath: coreState.selectionAnchorPath,
    };

    // Fetch new data without touching UI state — avoids flash on no-change.
    const streamedEntries: FileEntry[] = [];
    let cancelled = false;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const result = await dirListing.load(refreshPath, {
      onEntries: (entries) => {
        for (const entry of entries) streamedEntries.push(entry);
      },
      onDone: () => resolveDone(),
      onCancelled: () => {
        cancelled = true;
        resolveDone();
      },
    });

    if (!result.ok) {
      // The pane navigated away while the fetch was in flight — not our call.
      if (coreState.currentPath !== refreshPath || !ctx.allowRefresh(refreshPath)) return;
      // Directory no longer exists — fall back to parent
      await ctx.navigateToParent();
      return;
    }

    if (result.streaming) await donePromise;

    // Bail if superseded: a navigation cancelled the listing or changed path.
    if (cancelled || coreState.currentPath !== refreshPath || !ctx.allowRefresh(refreshPath)) return;

    // We now hold a complete listing for the pane's current path. If this
    // refresh interrupted a still-streaming navigation to the same path
    // (cancelling its onDone), clear the spinner it left behind.
    coreState.loading = false;

    const allEntries = streamedEntries.length ? [...result.entries, ...streamedEntries] : result.entries;
    const current = coreState.entries;
    const listing = reconcileDirectoryEntries(oldEntries, current, allEntries);
    const selection = reconcileDirectorySelection(listing.entries, {
      selectedPaths: coreState.selectedPaths,
      cursorPath: coreState.cursorPath,
      anchorPath: coreState.selectionAnchorPath,
    }, oldSelection);
    coreState.entries = listing.entries;
    if (selection.selectedPaths !== coreState.selectedPaths) ctx.setSelection(selection.selectedPaths);
    coreState.cursorPath = selection.cursorPath;
    coreState.selectionAnchorPath = selection.anchorPath;
    if (listing.needsRefresh || selection.needsRefresh) ctx.requestReconcile(refreshPath);

    if (!silent) {
      toastStore.show(listing.entries === current ? "Already up to date" : "Refreshed", "info", { duration: 1500 });
    }
  };
}
