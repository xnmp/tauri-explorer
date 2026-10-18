/** Lazy peek extension of pane-watch's observation ownership (WHETHER).
 *
 * A peek's first listing for a slot identity (expand, re-open, a view or
 * folder returning, an explicit retry) is a read, not a change notification:
 * it goes straight to the HOW owner once observation is established, like a
 * pane's own navigation load. Only filesystem notifications (and refreshes
 * they cause) are scheduled through refresh-manager's debounce and storm
 * interval. */
import { isTauri } from "$lib/api/common";
import { pathComparison } from "$lib/domain/path";
import { isWindows } from "$lib/domain/platform";
import { choosePeekWatches } from "$lib/domain/folder-peek";
import { createDirectoryWatch } from "./directory-watch";
import { createGitRepoWatch } from "./git-repo-watch";
import { repoRootCache } from "./repo-root-cache.svelte";
import { ensureGitWatcherListener } from "./git-refresh";
import { cancelRefreshSubscriber, type requestRefresh } from "./refresh-manager";
import type { DirectoryChange } from "./directory-events";

interface PeekWatchDependencies {
  blocked(): boolean;
  prepare(path: string): Promise<void>;
  refreshPath?: (path: string, options: { silent: boolean; observedAt?: number }) => void | Promise<void>;
  createWatch?: typeof createDirectoryWatch;
  schedule: typeof requestRefresh;
  mergeChange(previous: DirectoryChange | undefined, change: DirectoryChange): DirectoryChange;
}

export function createPeekWatch(deps: PeekWatchDependencies) {
  type PeekSlot = { path: string; key: object; ready: boolean; initialized: boolean; watch: ReturnType<typeof createDirectoryWatch> | null };
  const peeks = new Map<string, PeekSlot>();
  const retiredPeeks = new Set<ReturnType<typeof createDirectoryWatch>>();
  let watchTail = Promise.resolve();
  let desiredWatches = new Set<string>();
  const unmatchedPeeks = new Map<string, DirectoryChange>();
  const gitWatches = new Map<string, ReturnType<typeof createGitRepoWatch>>();

  const dirty = new Map<string, DirectoryChange>();
  const { schedule, mergeChange } = deps;
  const remember = (change: DirectoryChange) => { dirty.set(change.path, mergeChange(dirty.get(change.path), change)); };
  /** Read now, through pane-refresh. Observation is already held (or has
   * definitively fallen back), so the scan covers every earlier change. */
  function readPeek(slot: PeekSlot): void {
    if (deps.blocked() || peeks.get(slot.path) !== slot || !slot.ready) return;
    cancelRefreshSubscriber(slot.path, slot.key);
    void deps.refreshPath?.(slot.path, { silent: true });
  }
  function requestPeek(slot: PeekSlot, change: DirectoryChange = { path: slot.path }): void {
    if (!slot.ready) { remember({ ...change, path: slot.path }); return; }
    const identity = slot.key;
    schedule(options => {
      if (deps.blocked() || peeks.get(slot.path) !== slot || slot.key !== identity) return false;
      if (!slot.ready) { remember({ ...change, path: slot.path }); return false; }
      // The observation time lets listing-derived owners (Git badges) skip
      // work a window-level subscriber already started for this change.
      return deps.refreshPath?.(slot.path, { ...options, observedAt: change.observedAt });
    }, slot.path, true, slot.key, change.observedAt, change.origin);
  }
  function releasePeek(path: string): void {
    const slot = peeks.get(path);
    if (!slot) return;
    peeks.delete(path);
    dirty.delete(path);
    cancelRefreshSubscriber(path, slot.key);
    if (slot.watch) retiredPeeks.add(slot.watch);
  }
  async function drainObsoleteWatches(): Promise<boolean> {
    for (const slot of peeks.values()) {
      if (slot.watch && !desiredWatches.has(slot.path)) {
        retiredPeeks.add(slot.watch); slot.watch = null;
      }
    }
    let drained = true;
    for (const owner of retiredPeeks) {
      try { await owner.destroy(); retiredPeeks.delete(owner); }
      catch { drained = false; }
    }
    return drained;
  }
  function reconcile(paths: readonly string[], order: ReadonlyMap<string, number>): void {
    const wanted = new Set(deps.blocked() ? [] : paths);
    for (const path of peeks.keys()) if (!wanted.has(path)) releasePeek(path);
    for (const path of wanted) if (!peeks.has(path)) peeks.set(path, { path, key: {}, ready: false, initialized: false, watch: null });
    desiredWatches = new Set(choosePeekWatches([...wanted], order));
    watchTail = watchTail.then(async () => {
      await drainObsoleteWatches();
      for (const slot of peeks.values()) {
        const drained = await drainObsoleteWatches();
        if (deps.blocked()) break;
        if (peeks.get(slot.path) !== slot) continue;
        let needsScan = !slot.initialized;
        if (drained && desiredWatches.has(slot.path) && !slot.watch?.held) {
          slot.ready = false;
          const owner = slot.watch ?? (deps.createWatch ?? createDirectoryWatch)();
          slot.watch = owner;
          try {
            await deps.prepare(slot.path);
            if (await drainObsoleteWatches() && !deps.blocked() && peeks.get(slot.path) === slot
              && desiredWatches.has(slot.path)) await owner.update(slot.path);
          } catch (error) { console.error("Peek observation failed:", error); }
          const acquired = !!owner.held;
          if (peeks.get(slot.path) !== slot) retiredPeeks.add(owner);
          // The desired set can change during acquisition. Retire the returned
          // lease before admitting its replacement, including failed releases.
          await drainObsoleteWatches();
          if (peeks.get(slot.path) !== slot) continue;
          if (acquired) {
            cancelRefreshSubscriber(slot.path, slot.key);
            slot.key = {};
            needsScan = true;
          }
        }
        slot.ready = true;
        slot.initialized = true;
        {
          const resolved = slot.watch?.held?.lease.path;
          const aliasChange = resolved ? unmatchedPeeks.get(resolved) : undefined;
          const change = aliasChange ? mergeChange(dirty.get(slot.path), { ...aliasChange, path: slot.path }) : dirty.get(slot.path);
          dirty.delete(slot.path);
          if (resolved) unmatchedPeeks.delete(resolved);
          if (needsScan) readPeek(slot);
          else if (change) requestPeek(slot, change);
        }
      }
      if (isTauri()) {
        const roots = new Set<string>();
        for (const slot of peeks.values()) {
          if (!slot.watch?.held || !desiredWatches.has(slot.path)) continue;
          await repoRootCache.ensure(slot.path);
          if (peeks.get(slot.path) !== slot || !desiredWatches.has(slot.path)) continue;
          const root = repoRootCache.get(slot.path);
          if (root) roots.add(root);
        }
        for (const [root, owner] of gitWatches) {
          if (!roots.has(root)) {
            try { await owner.destroy(); gitWatches.delete(root); }
            catch (error) { console.error("Peek Git release failed:", error); }
          }
        }
        if (roots.size && await ensureGitWatcherListener()) {
          for (const root of roots) {
            if (deps.blocked()) continue;
            const owner = gitWatches.get(root) ?? createGitRepoWatch();
            if (owner.held) continue;
            gitWatches.set(root, owner);
            try { await owner.update(root); } catch (error) { console.error("Peek Git observation failed:", error); }
          }
        }
      }
      if ([...peeks.values()].every(slot => slot.ready)) unmatchedPeeks.clear();
      // A collapse may have happened while acquisition was pending.
      for (const owner of retiredPeeks) {
        try { await owner.destroy(); retiredPeeks.delete(owner); } catch { /* retained for retry */ }
      }
    }).catch(error => console.error("Peek observation reconciliation failed:", error));
  }
  return {
    reconcile,
    changed(change: DirectoryChange): boolean {
      const slot = [...peeks.values()].find(slot => slot.path === change.path || slot.watch?.held?.lease.path === change.path);
      if (slot) { requestPeek(slot, change); return true; }
      if ([...peeks.values()].some(slot => !slot.ready) && (unmatchedPeeks.has(change.path) || unmatchedPeeks.size < 256)) {
        unmatchedPeeks.set(change.path, mergeChange(unmatchedPeeks.get(change.path), change));
      }
      return false;
    },
    requestPath(path: string): boolean {
      const slot = [...peeks.values()].find(slot => pathComparison(isWindows).same(slot.path, path));
      if (slot) requestPeek(slot);
      return !!slot;
    },
    /** Pane refresh fan-out. An explicit (user) refresh reads every ready
     * peek now; an ordinary one reaches unwatched peeks through scheduling. */
    refresh(explicit: boolean) {
      for (const slot of peeks.values()) {
        if (explicit && slot.ready) readPeek(slot);
        else if (explicit || !slot.watch?.held) requestPeek(slot);
      }
    },
    snapshot() {
      return [...peeks.values()].map(slot => ({ path: slot.path, ready: slot.ready, lease: slot.watch?.held?.lease ?? null }));
    },
    async destroy() {
      reconcile([], new Map());
      await watchTail;
      const results = await Promise.allSettled([
        ...[...gitWatches].map(async ([root, owner]) => { await owner.destroy(); gitWatches.delete(root); }),
        ...[...retiredPeeks].map(async owner => { await owner.destroy(); retiredPeeks.delete(owner); }),
      ]);
      if (results.some(result => result.status === "rejected")) throw new Error("Peek observation release did not complete");
    },
  };
}
