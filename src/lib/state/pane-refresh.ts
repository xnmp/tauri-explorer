/**
 * Per-pane refresh: re-list the current directory without flashing the UI
 * when nothing changed. Extracted from explorer.svelte.ts.
 *
 * Invariants preserved from the original implementation:
 * - only complete snapshots are reconciled
 * - the result is discarded if the pane navigated away mid-fetch
 *   (path-change bail) or the listing was cancelled by a newer load
 * - unchanged listings do not publish, including watcher echoes of local work
 */

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
    const result = await dirListing.load(refreshPath);
    if (!result.ok && result.cancelled) return;

    if (!result.ok) {
      // The pane navigated away while the fetch was in flight — not our call.
      if (coreState.currentPath !== refreshPath || !ctx.allowRefresh(refreshPath)) return;
      // Directory no longer exists — fall back to parent
      await ctx.navigateToParent();
      return;
    }

    // Bail if superseded: a navigation cancelled the listing or changed path.
    if (coreState.currentPath !== refreshPath || !ctx.allowRefresh(refreshPath)) return;

    coreState.loading = false;

    const current = coreState.entries;
    const listing = reconcileDirectoryEntries(oldEntries, current, result.entries);
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
