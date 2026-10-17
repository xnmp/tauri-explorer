/** Per-Explorer membership and listing resources. Refresh policy stays in the
 * shared WHEN/WHETHER/HOW owners; this store only owns publication lifetimes. */
import { createPeekWatch } from "./pane-peek-watch";
import { pathComparison } from "$lib/domain/path";
import type { FileEntry } from "$lib/domain/file";
import * as policies from "$lib/domain/folder-peek";
import { toggleExpanded, collapseSubtree, pruneExpanded, type PeekListing } from "$lib/domain/folder-peek";
import { rememberCardRows } from "$lib/domain/list-cards";
import { createDirectoryListing } from "./directory-listing";
import { gitStatusStore } from "./git-status.svelte";
import type { RefreshTarget } from "./pane-refresh";

export function createFolderPeekSession(windows: boolean) {
  let expanded = $state.raw<ReadonlyMap<string, number>>(new Map());
  let snapshots = $state.raw<ReadonlyMap<string, PeekListing>>(new Map());
  /** List card heights (visible rows) per top-level path, for the session. */
  let cardRows = $state.raw<ReadonlyMap<string, number>>(new Map());
  let ordinal = 0;
  let disposed = false;
  const resources = new Map<string, { target: RefreshTarget; retire(): Promise<void> }>();
  const retiring = new Set<Promise<void>>();
  const retired = new Set<{ retire(): Promise<void> }>();
  /** Git badge ownership, held only while badges are shown. */
  const gitOwners = new Map<string, () => void>();
  function reconcileGit(paths: Iterable<string>) {
    const desired = new Set(paths);
    for (const [path, release] of gitOwners) if (!desired.has(path)) { gitOwners.delete(path); release(); }
    for (const path of desired) {
      if (gitOwners.has(path)) continue;
      gitOwners.set(path, gitStatusStore.trackDirectory(path));
      void gitStatusStore.fetchForDirectory(path);
    }
  }

  function publish(path: string, listing: PeekListing) {
    snapshots = new Map(snapshots).set(path, listing);
  }
  function retire(path: string) {
    const resource = resources.get(path);
    if (!resource) return;
    resources.delete(path);
    const next = new Map(snapshots); next.delete(path); snapshots = next;
    retired.add(resource);
    const task = resource.retire().then(() => { retired.delete(resource); }, error => {
      console.error("Peek listing cleanup failed:", error);
    }).finally(() => retiring.delete(task));
    retiring.add(task);
  }
  function reconcile(paths: readonly string[], git = false) {
    const desired = new Set(disposed ? [] : paths);
    reconcileGit(git ? desired : []);
    for (const path of resources.keys()) if (!desired.has(path)) retire(path);
    for (const path of desired) {
      if (resources.has(path)) continue;
      const owner = createDirectoryListing();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const current = () => !disposed && resources.get(path)?.target === target;
      const settle = () => { clearTimeout(timer); timer = undefined; };
      const target: RefreshTarget = {
        dirListing: owner,
        current,
        get entries() { return snapshots.get(path)?.entries ?? []; },
        get initial() { return snapshots.get(path)?.status === "loading"; },
        set entries(entries: readonly FileEntry[]) {
          if (!current()) return;
          settle(); publish(path, { status: "loaded", entries });
        },
        fail(error: string) {
          if (!current()) return;
          settle(); publish(path, { status: "error", entries: [], error });
        },
      };
      resources.set(path, { target, retire: () => { settle(); return owner.cleanup(); } });
      publish(path, { status: "loading", entries: [], showLoading: false });
      timer = setTimeout(() => {
        if (current() && snapshots.get(path)?.status === "loading") publish(path, { status: "loading", entries: [], showLoading: true });
      }, 150);
    }
  }
  return {
    policies, watchFactory: createPeekWatch,
    get expanded() { return expanded; },
    toggle(path: string) { if (!disposed) expanded = toggleExpanded(expanded, path, ++ordinal); },
    collapse(path: string) { if (expanded.has(path)) { const next = new Map(expanded); next.delete(path); expanded = next; } },
    collapseAll(roots: readonly string[]) {
      const next = collapseSubtree(expanded, roots, windows);
      if (next.size !== expanded.size) expanded = next;
    },
    prune(parent: string, entries: readonly FileEntry[]) {
      const next = pruneExpanded(expanded, parent, entries, windows);
      if (next.size !== expanded.size) expanded = next;
    },
    listing(path: string) { return snapshots.get(path); },
    cardRows(path: string) { return cardRows.get(path); },
    setCardRows(path: string, rows: number) { if (!disposed) cardRows = rememberCardRows(cardRows, path, rows); },
    target(path: string) { return [...resources].find(([key]) => pathComparison(windows).same(key, path))?.[1].target; },
    reconcile,
    async dispose() {
      disposed = true; reconcile([]);
      await Promise.all([...retiring]);
      const results = await Promise.allSettled([...retired].map(async resource => { await resource.retire(); retired.delete(resource); }));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
