/** Per-pane observation ownership and the WHETHER layer of refresh policy. */
import { unwatchDirectory, type DirectoryWatchLease } from "$lib/api/files";
import { isTauri } from "$lib/api/common";
import { getNativeResourceSession } from "$lib/api/native-resource-session";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { directoryEvents, type DirectoryChange, type DirectorySubscription } from "./directory-events";
import { pathComparison } from "$lib/domain/path";
import { isWindows } from "$lib/domain/platform";
import { createGitRepoWatch } from "./git-repo-watch";
import { repoRootCache } from "./repo-root-cache.svelte";
import { ensureGitWatcherListener } from "./git-refresh";
import { createDirectoryWatch } from "./directory-watch";
import { choosePeekWatches } from "$lib/domain/folder-peek";
import { cancelRefreshSubscriber, requestRefresh } from "./refresh-manager";

type Refresh = (options: { silent: boolean }) => void | Promise<void>;
interface PaneWatchDependencies {
  refresh: Refresh;
  currentPath?: () => string;
  refreshPath?: (path: string, options: { silent: boolean }) => void | Promise<void>;
  createWatch?: typeof createDirectoryWatch;
  subscribe?: (callback: (change: DirectoryChange) => void) => DirectorySubscription;
  release?: (lease: DirectoryWatchLease) => Promise<void>;
  prepare?: (path: string, subscription: DirectorySubscription) => Promise<void>;
  schedule?: typeof requestRefresh;
}
interface Navigation {
  path: string;
  startedAt: number;
  staged: DirectoryWatchLease | null | undefined;
  unmatched: Map<string, DirectoryChange>;
  unmatchedOverflow: boolean;
  closed: boolean;
  done: Promise<void>;
  finish(): void;
}

const MAX_PENDING_UNMATCHED_CHANGES = 256;

function mergeChange(previous: DirectoryChange | undefined, change: DirectoryChange): DirectoryChange {
  return previous ? {
    path: change.path,
    origin: previous.origin === "mutation" || change.origin === "mutation" ? "mutation" : "watcher",
    observedAt: previous.observedAt == null || change.observedAt == null
      ? undefined : Math.max(previous.observedAt, change.observedAt),
  } : change;
}

export function createPaneWatch(deps: PaneWatchDependencies) {
  const releaseCommand = deps.release ?? unwatchDirectory;
  const schedule = deps.schedule ?? requestRefresh;
  let key = {};
  type PeekSlot = { path: string; key: object; ready: boolean; watch: ReturnType<typeof createDirectoryWatch> | null };
  const peeks = new Map<string, PeekSlot>();
  const retiredPeeks = new Set<ReturnType<typeof createDirectoryWatch>>();
  let watchTail = Promise.resolve();
  let desiredWatches = new Set<string>();
  const unmatchedPeeks = new Map<string, DirectoryChange>();
  const gitWatches = new Map<string, ReturnType<typeof createGitRepoWatch>>();

  function requestPeek(slot: PeekSlot, change: DirectoryChange = { path: slot.path }): void {
    if (!slot.ready) { remember({ ...change, path: slot.path }); return; }
    schedule(options => {
      if (destroyed || pending || peeks.get(slot.path) !== slot || !slot.ready) return false;
      return deps.refreshPath?.(slot.path, options);
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
  function reconcilePeeks(paths: readonly string[], order: ReadonlyMap<string, number>): void {
    const wanted = new Set(destroyed || pending ? [] : paths);
    for (const path of peeks.keys()) if (!wanted.has(path)) releasePeek(path);
    for (const path of wanted) if (!peeks.has(path)) peeks.set(path, { path, key: {}, ready: false, watch: null });
    desiredWatches = new Set(choosePeekWatches([...wanted], order));
    watchTail = watchTail.then(async () => {
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
      for (const slot of peeks.values()) {
        if (destroyed || pending) break;
        if (drained && desiredWatches.has(slot.path) && !slot.watch?.held) {
          slot.ready = false;
          cancelRefreshSubscriber(slot.path, slot.key);
          const owner = slot.watch ?? (deps.createWatch ?? createDirectoryWatch)();
          slot.watch = owner;
          try { await prepare(slot.path, subscription); await owner.update(slot.path); }
          catch (error) { console.error("Peek observation failed:", error); }
          if (peeks.get(slot.path) !== slot) { retiredPeeks.add(owner); continue; }
        }
        if (!slot.ready) {
          slot.ready = true;
          const resolved = slot.watch?.held?.lease.path;
          const aliasChange = resolved ? unmatchedPeeks.get(resolved) : undefined;
          const change = aliasChange ? mergeChange(dirty.get(slot.path), { ...aliasChange, path: slot.path }) : dirty.get(slot.path);
          dirty.delete(slot.path);
          if (resolved) unmatchedPeeks.delete(resolved);
          requestPeek(slot, change);
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
          if (!roots.has(root)) { await owner.destroy(); gitWatches.delete(root); }
        }
        if (roots.size && await ensureGitWatcherListener()) {
          for (const root of roots) {
            if (destroyed || pending || gitWatches.has(root)) continue;
            const owner = createGitRepoWatch(); gitWatches.set(root, owner);
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
  let committed: { path: string; lease: DirectoryWatchLease | null } | null = null;
  let pending: Navigation | null = null;
  const navigations = new Set<Navigation>();
  const dirty = new Map<string, DirectoryChange>();
  const retired = new Map<string, DirectoryWatchLease>();
  const releases = new Set<Promise<void>>();
  let destroyed = false;
  let disposal: Promise<void> | undefined;

  function release(lease: DirectoryWatchLease): void {
    if (retired.has(lease.id)) return;
    retired.set(lease.id, lease);
    attemptRelease(lease);
  }
  function attemptRelease(lease: DirectoryWatchLease): void {
    const task = Promise.resolve().then(() => releaseCommand(lease)).then(
      () => { retired.delete(lease.id); },
      (error) => { console.error("Directory observation release failed:", error); },
    ).finally(() => { releases.delete(task); });
    releases.add(task);
  }
  function remember(change: DirectoryChange): void {
    dirty.set(change.path, mergeChange(dirty.get(change.path), change));
  }
  function request(change: DirectoryChange): void {
    const identity = key;
    schedule((options) => {
      if (destroyed || identity !== key || (committed?.path ?? deps.currentPath?.()) !== change.path) return false;
      if (pending) {
        remember(change);
        return false;
      }
      return deps.refresh(options);
    }, change.path, true, key, change.observedAt, change.origin);
  }
  function flush(path: string | undefined): void {
    const change = path ? dirty.get(path) : undefined;
    if (path) dirty.delete(path);
    if (change && !destroyed) request(change);
  }
  function changed(change: DirectoryChange): void {
    if (destroyed) return;
    const peek = [...peeks.values()].find(slot => slot.path === change.path || slot.watch?.held?.lease.path === change.path);
    if (peek) { requestPeek(peek, change); return; }
    if (!pending && committed?.path !== change.path && [...peeks.values()].some(slot => !slot.ready)
      && (unmatchedPeeks.has(change.path) || unmatchedPeeks.size < MAX_PENDING_UNMATCHED_CHANGES)) {
      unmatchedPeeks.set(change.path, mergeChange(unmatchedPeeks.get(change.path), change));
    }
    if (pending) {
      // Observation starts before the listing returns its resolved lease path.
      // Retain unmatched events during that handoff; accept() rekeys the one
      // belonging to the resolved navigation and commit() drops the rest.
      if (committed?.path !== change.path && pending.path !== change.path) {
        if (pending.unmatched.has(change.path) || pending.unmatched.size < MAX_PENDING_UNMATCHED_CHANGES) {
          pending.unmatched.set(change.path, mergeChange(pending.unmatched.get(change.path), change));
        } else {
          pending.unmatchedOverflow = true;
        }
        return;
      }
      // The forthcoming scan covers changes observed before navigation began.
      if (pending.path === change.path && change.observedAt != null && change.observedAt < pending.startedAt) return;
      remember(change);
    } else if (committed?.path === change.path) {
      request(change);
    }
  }
  const subscription = (deps.subscribe ?? directoryEvents.subscribe)(changed);
  const prepare = deps.prepare ?? ((path: string, events: DirectorySubscription) => {
    if (!isTauri() || isVirtualPath(path)) return Promise.resolve();
    return Promise.all([events.ready(), getNativeResourceSession()]).then(() => {});
  });

  function begin(path: string) {
    for (const peekPath of peeks.keys()) releasePeek(peekPath);
    reconcilePeeks([], new Map());
    if (committed) cancelRefreshSubscriber(committed.path, key);
    key = {};
    if (pending?.staged) release(pending.staged);
    if (pending) pending.staged = undefined;
    for (const oldPath of dirty.keys()) {
      if (oldPath !== committed?.path) dirty.delete(oldPath);
    }
    let finish!: () => void;
    const navigation: Navigation = {
      path, startedAt: Date.now(), staged: undefined,
      unmatched: new Map(), unmatchedOverflow: false, closed: false,
      done: new Promise<void>((resolve) => { finish = resolve; }),
      finish: () => finish(),
    };
    navigations.add(navigation);
    pending = navigation;
    const ready = destroyed ? Promise.reject(new Error("Pane observation is destroyed"))
      : Promise.resolve().then(() => prepare(path, subscription));
    void ready.catch(() => {});
    const current = () => !destroyed && !navigation.closed && pending === navigation;
    const close = () => {
      if (navigation.closed) return;
      navigation.closed = true;
      if (navigation.staged) release(navigation.staged);
      navigation.staged = undefined;
      if (pending === navigation) {
        pending = null;
        flush(committed?.path);
      }
      navigations.delete(navigation);
      navigation.finish();
    };
    return {
      ready,
      current,
      // The listing owner transfers observation before publishing a snapshot.
      // The old committed lease survives until the caller commits its UI state.
      accept(lease: DirectoryWatchLease | null): boolean {
        if (!current() || navigation.staged !== undefined) return false;
        if (lease && navigation.path !== lease.path) {
          const changes = [dirty.get(navigation.path), navigation.unmatched.get(lease.path)];
          dirty.delete(navigation.path);
          navigation.path = lease.path;
          for (const change of changes) {
            if (change && (change.observedAt == null || change.observedAt >= navigation.startedAt)) {
              remember({ ...change, path: lease.path });
            }
          }
          if (navigation.unmatchedOverflow) remember({ path: lease.path });
        }
        navigation.unmatched.clear();
        navigation.staged = lease;
        return true;
      },
      discard: release,
      commit(): boolean {
        if (!current() || navigation.staged === undefined) return false;
        const previous = committed;
        const lease = navigation.staged;
        const committedPath = navigation.path;
        committed = { path: committedPath, lease };
        navigation.staged = undefined;
        pending = null;
        if (previous?.lease) release(previous.lease);
        flush(committedPath);
        close();
        return true;
      },
      close,
    };
  }

  return {
    begin,
    changed,
    reconcilePeeks,
    invalidatePeeks() { for (const path of peeks.keys()) releasePeek(path); reconcilePeeks([], new Map()); },
    requestPath(path: string) {
      const slot = [...peeks.values()].find(slot => pathComparison(isWindows).same(slot.path, path));
      const root = committed?.path ?? deps.currentPath?.();
      if (slot) requestPeek(slot);
      else if (root && pathComparison(isWindows).same(root, path)) request({ path: root });
    },
    refreshPeeks(explicit: boolean) {
      for (const slot of peeks.values()) if (explicit || !slot.watch?.held) requestPeek(slot);
    },
    peekSnapshot() {
      return [...peeks.values()].map(slot => ({ path: slot.path, ready: slot.ready, lease: slot.watch?.held?.lease ?? null }));
    },
    allowRefresh(path: string): boolean {
      if (destroyed) return false;
      if (!pending) return true;
      if (committed?.path === path) remember({ path });
      return false;
    },
    destroy(): Promise<void> {
      if (disposal) return disposal;
      destroyed = true;
      for (const path of peeks.keys()) releasePeek(path);
      if (committed) cancelRefreshSubscriber(committed.path, key);
      reconcilePeeks([], new Map());
      subscription.stop();
      dirty.clear();
      if (committed?.lease) release(committed.lease);
      committed = null;
      for (const navigation of navigations) {
        if (navigation.staged) release(navigation.staged);
        navigation.staged = undefined;
      }
      const attempt = (async () => {
        // An in-flight observed reply still owns a possible lease. Its caller
        // always closes the ticket, including rejected/stale results.
        await watchTail;
        for (const [root, owner] of gitWatches) { await owner.destroy(); gitWatches.delete(root); }
        for (const owner of retiredPeeks) { await owner.destroy(); retiredPeeks.delete(owner); }
        await Promise.all([...navigations].map((navigation) => navigation.done));
        while (releases.size) await Promise.all([...releases]);
        for (const lease of retired.values()) attemptRelease(lease);
        while (releases.size) await Promise.all([...releases]);
        if (retired.size) throw new Error("Directory observation release did not complete");
      })();
      disposal = attempt;
      void attempt.catch(() => { if (disposal === attempt) disposal = undefined; });
      return attempt;
    },
  };
}

export type PaneWatch = ReturnType<typeof createPaneWatch>;
