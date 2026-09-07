/** Per-pane observation ownership and the WHETHER layer of refresh policy. */
import { unwatchDirectory, type DirectoryWatchLease } from "$lib/api/files";
import { isTauri } from "$lib/api/common";
import { getNativeResourceSession } from "$lib/api/native-resource-session";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { directoryEvents, type DirectoryChange, type DirectorySubscription } from "./directory-events";
import { requestRefresh } from "./refresh-manager";

export const MUTATION_COOLDOWN_MS = 1000;

type Refresh = (options: { silent: boolean }) => void | Promise<void>;
interface PaneWatchDependencies {
  refresh: Refresh;
  subscribe?: (callback: (change: DirectoryChange) => void) => DirectorySubscription;
  release?: (lease: DirectoryWatchLease) => Promise<void>;
  prepare?: (path: string, subscription: DirectorySubscription) => Promise<void>;
  schedule?: typeof requestRefresh;
}
interface Navigation {
  path: string;
  startedAt: number;
  staged: DirectoryWatchLease | null | undefined;
  closed: boolean;
  done: Promise<void>;
  finish(): void;
}

export function createPaneWatch(deps: PaneWatchDependencies) {
  const releaseCommand = deps.release ?? unwatchDirectory;
  const schedule = deps.schedule ?? requestRefresh;
  const key = {};
  let committed: { path: string; lease: DirectoryWatchLease | null } | null = null;
  let pending: Navigation | null = null;
  const navigations = new Set<Navigation>();
  const dirty = new Map<string, DirectoryChange>();
  const retired = new Map<string, DirectoryWatchLease>();
  const releases = new Set<Promise<void>>();
  let destroyed = false;
  let disposal: Promise<void> | undefined;
  let lastMutationTime = 0;

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
    const previous = dirty.get(change.path);
    dirty.set(change.path, previous ? {
      path: change.path,
      observedAt: previous.observedAt == null || change.observedAt == null
        ? undefined : Math.max(previous.observedAt, change.observedAt),
    } : change);
  }
  function request(change: DirectoryChange): void {
    schedule((options) => {
      if (destroyed || committed?.path !== change.path) return false;
      if (pending) {
        remember(change);
        return false;
      }
      return deps.refresh(options);
    }, change.path, true, key, change.observedAt);
  }
  function flush(path: string | undefined): void {
    const change = path ? dirty.get(path) : undefined;
    dirty.clear();
    if (change && !destroyed) request(change);
  }
  function changed(change: DirectoryChange): void {
    if (destroyed || (committed?.path !== change.path && pending?.path !== change.path)) return;
    if (pending) {
      // The forthcoming scan covers changes observed before navigation began.
      if (pending.path === change.path && change.observedAt != null && change.observedAt < pending.startedAt) return;
      remember(change);
    } else {
      request(change);
    }
  }
  const subscription = (deps.subscribe ?? directoryEvents.subscribe)(changed);
  const prepare = deps.prepare ?? ((path: string, events: DirectorySubscription) => {
    if (!isTauri() || isVirtualPath(path)) return Promise.resolve();
    return Promise.all([events.ready(), getNativeResourceSession()]).then(() => {});
  });

  function begin(path: string) {
    if (pending?.staged) release(pending.staged);
    if (pending) pending.staged = undefined;
    for (const oldPath of dirty.keys()) {
      if (oldPath !== committed?.path) dirty.delete(oldPath);
    }
    let finish!: () => void;
    const navigation: Navigation = {
      path, startedAt: Date.now(), staged: undefined, closed: false,
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
      // The transport transfers ownership before publishing stream callbacks.
      // The old committed lease survives until the caller commits its UI state.
      accept(lease: DirectoryWatchLease | null): boolean {
        if (!current() || navigation.staged !== undefined) return false;
        navigation.staged = lease;
        return true;
      },
      discard: release,
      commit(): boolean {
        if (!current() || navigation.staged === undefined) return false;
        const previous = committed;
        committed = { path, lease: navigation.staged };
        navigation.staged = undefined;
        pending = null;
        if (previous?.lease) release(previous.lease);
        flush(path);
        close();
        return true;
      },
      close,
    };
  }

  return {
    begin,
    changed,
    allowRefresh(path: string): boolean {
      if (destroyed) return false;
      if (!pending) return true;
      if (committed?.path === path) remember({ path });
      return false;
    },
    markLocalMutation() { lastMutationTime = Date.now(); },
    inMutationCooldown() { return Date.now() - lastMutationTime < MUTATION_COOLDOWN_MS; },
    destroy(): Promise<void> {
      if (disposal) return disposal;
      destroyed = true;
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
