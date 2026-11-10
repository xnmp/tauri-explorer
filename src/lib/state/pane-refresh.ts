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

export interface RefreshTarget {
  entries: readonly import("$lib/domain/file").FileEntry[];
  dirListing: ReturnType<typeof createDirectoryListing>;
  current(): boolean;
  fail(error: string): void | Promise<void>;
  /** True until the target's first listing publishes. */
  readonly initial?: boolean;
}

/** What one publication changed, for owners of listing-derived state. */
export interface RefreshPublication {
  /** A complete snapshot could not establish removals; another read follows. */
  needsRefresh: boolean;
  /** The published entries differ from the ones they replace. */
  changed: boolean;
  /** The target's first listing (its owner loaded derived state already). */
  initial: boolean;
  /** When the change that caused this read was observed, if it was. */
  observedAt?: number;
}

export interface RefreshOptions { silent?: boolean; explicit?: boolean; observedAt?: number }

export interface PaneRefreshContext {
  coreState: ExplorerCoreState;
  dirListing: ReturnType<typeof createDirectoryListing>;
  allowRefresh: (path: string) => boolean;
  setSelection: (next: Iterable<string>) => void;
  /** Schedule a fresh observation through the existing WHEN/WHETHER owners. */
  requestReconcile: (path: string) => void;
  /** Fallback when the current directory no longer exists. */
  navigateToParent: () => Promise<void>;
  targetFor?: (path: string) => RefreshTarget | undefined;
  ownsPath?: (entryPath: string, directory: string) => boolean;
  published?: (path: string, entries: readonly import("$lib/domain/file").FileEntry[], publication: RefreshPublication) => void;
  fanOut?: (explicit: boolean) => void;
}

export function createPaneRefresh(ctx: PaneRefreshContext) {
  const { coreState, dirListing } = ctx;

  const pending = new Map<string, { promise: Promise<void> }>();

  async function refreshOnce(refreshPath: string, options?: RefreshOptions): Promise<void> {
    const silent = options?.silent ?? false;
    const root = coreState.currentPath;
    const target = refreshPath === root ? undefined : ctx.targetFor?.(refreshPath);
    if (refreshPath !== root && !target) return;
    const currentTarget = () => coreState.currentPath === root && (target ? target.current() : true);
    if (!ctx.allowRefresh(refreshPath)) return;
    const oldEntries = target?.entries ?? coreState.entries;
    const oldSelection = {
      selectedPaths: new Set(coreState.selectedPaths),
      cursorPath: coreState.cursorPath,
      anchorPath: coreState.selectionAnchorPath,
    };

    // Fetch new data without touching UI state — avoids flash on no-change.
    const result = await (target?.dirListing ?? dirListing).load(refreshPath);
    if (!result.ok && result.cancelled) return;

    if (!result.ok) {
      // The pane navigated away while the fetch was in flight — not our call.
      if (!currentTarget() || !ctx.allowRefresh(refreshPath)) return;
      // Directory no longer exists — fall back to parent
      if (target) await target.fail(result.error);
      else await ctx.navigateToParent();
      return;
    }

    // Bail if superseded: a navigation cancelled the listing or changed path.
    if (!currentTarget() || !ctx.allowRefresh(refreshPath)) return;

    if (!target) coreState.loading = false;

    const current = target?.entries ?? coreState.entries;
    const initial = target?.initial ?? false;
    const listing = reconcileDirectoryEntries(oldEntries, current, result.entries);
    // Reconcile only identities owned by this directory; selected children in
    // other live peeks survive a parent refresh.
    const owns = (path: string) => ctx.ownsPath?.(path, refreshPath) ?? true;
    const partition = (value: typeof oldSelection) => ({
      selectedPaths: new Set([...value.selectedPaths].filter(owns)),
      cursorPath: value.cursorPath && owns(value.cursorPath) ? value.cursorPath : null,
      anchorPath: value.anchorPath && owns(value.anchorPath) ? value.anchorPath : null,
    });
    const nowSelection = {
      selectedPaths: coreState.selectedPaths,
      cursorPath: coreState.cursorPath,
      anchorPath: coreState.selectionAnchorPath,
    };
    const selection = reconcileDirectorySelection(listing.entries, partition(nowSelection), partition(oldSelection));
    const selectedPaths = new Set([...coreState.selectedPaths].filter(path => !owns(path)));
    for (const path of selection.selectedPaths) selectedPaths.add(path);
    if (target) target.entries = listing.entries;
    else coreState.entries = listing.entries;
    ctx.setSelection(selectedPaths);
    if (!coreState.cursorPath || owns(coreState.cursorPath)) coreState.cursorPath = selection.cursorPath;
    if (!coreState.selectionAnchorPath || owns(coreState.selectionAnchorPath)) coreState.selectionAnchorPath = selection.anchorPath;
    ctx.published?.(refreshPath, listing.entries, { needsRefresh: listing.needsRefresh, changed: listing.entries !== current, initial, observedAt: options?.observedAt });
    if (!target) ctx.fanOut?.(options?.explicit ?? false);
    if (listing.needsRefresh || selection.needsRefresh) ctx.requestReconcile(refreshPath);

    if (!silent) {
      toastStore.show(listing.entries === current ? "Already up to date" : "Refreshed", "info", { duration: 1500 });
    }
  }

  return async function refresh(options?: RefreshOptions, path = coreState.currentPath): Promise<void> {
    const target = path === coreState.currentPath ? undefined : ctx.targetFor?.(path);
    const request = { promise: refreshOnce(path, options) };
    pending.set(path, request);
    let observed = request;
    try {
      await observed.promise;
      while (pending.get(path) && pending.get(path) !== observed && (target ? target.current() : coreState.currentPath === path)) {
        observed = pending.get(path)!;
        await observed.promise;
      }
    } finally {
      if (pending.get(path) === observed) pending.delete(path);
    }
  };
}
