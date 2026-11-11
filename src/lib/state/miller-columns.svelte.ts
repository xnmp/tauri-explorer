/**
 * Ancestor-directory listings for one Miller columns surface (#598, #1642).
 *
 * The columns list directories outside the pane's own listing, so they keep
 * their own bounded cache. Each column is a latest-request-wins slot: a slow
 * listing can never overwrite the newer one that superseded it.
 *
 * Refresh follows the shared policy without a gate of its own. A column's
 * first read, and a re-read after a local mutation (the operation's reply
 * already proves the directory changed, #598), go straight to the listing.
 * Filesystem notifications are scheduled through refresh-manager (WHEN), whose
 * callback declines a column that is no longer shown.
 */
import { untrack } from "svelte";
import { fetchDirectory, isDirectoryEmpty } from "$lib/api/files";
import type { FileEntry } from "$lib/domain/file";
import { parentDir } from "$lib/domain/path";
import { beginSlot, idleSlot, isSlotCurrent, settleSlot, slotData, type Slot } from "$lib/domain/request-slot";
import { directoryEvents, type DirectoryChange, type DirectorySubscription } from "./directory-events";
import { createDirectoryWatch } from "./directory-watch";
import { subscribeToLocalFileChanges } from "./file-events";
import { cancelRefreshSubscriber, requestRefresh } from "./refresh-manager";
import { settingsStore } from "./settings.svelte";

type Entries = readonly FileEntry[];
interface Watch { update(path: string): Promise<void>; destroy(): Promise<void> }

export interface MillerColumnsDependencies {
  list: typeof fetchDirectory;
  isEmpty: typeof isDirectoryEmpty;
  createWatch(): Watch;
  subscribe(callback: (change: DirectoryChange) => void): DirectorySubscription;
  subscribeLocal(callback: (dirs: string[]) => void): () => void;
  schedule: typeof requestRefresh;
  cancelScheduled(path: string, key: unknown): void;
  hideEmpty(): boolean;
  includeHidden(): boolean;
}

/** Hidden listings kept for returning to a column; shown columns never count against it. */
const MAX_CACHED_LISTINGS = 50;

export function createMillerColumns(deps: MillerColumnsDependencies = {
  list: fetchDirectory,
  isEmpty: isDirectoryEmpty,
  createWatch: createDirectoryWatch,
  subscribe: directoryEvents.subscribe,
  subscribeLocal: subscribeToLocalFileChanges,
  schedule: requestRefresh,
  cancelScheduled: cancelRefreshSubscriber,
  hideEmpty: () => settingsStore.millerHideEmpty,
  includeHidden: () => settingsStore.showHidden,
}) {
  // Authoritative listings, read untracked by commands; insertion order is
  // recency. Every change publishes an immutable copy for the columns.
  const listings = new Map<string, Slot<Entries>>();
  let published = $state.raw<ReadonlyMap<string, Slot<Entries>>>(new Map());
  const shown = new Set<string>();
  const watches = new Map<string, Watch>();
  // Shown columns with a scheduled watcher refresh that has not started yet.
  const dirty = new Set<string>();
  // Emptiness is cached per hidden-file visibility; a flip forgets it.
  let empty = $state.raw({ includeHidden: deps.includeHidden(), flags: new Map<string, boolean>() as ReadonlyMap<string, boolean> });
  const key = {};
  let tokens = 0;
  let disposed = false;

  const publish = () => { published = new Map(listings); };

  function evict(path: string): void {
    if (listings.delete(path)) publish();
  }

  function trimCache(): void {
    for (const path of listings.keys()) {
      if (listings.size <= MAX_CACHED_LISTINGS) break;
      if (!shown.has(path)) listings.delete(path);
    }
  }

  async function load(path: string): Promise<void> {
    const token = ++tokens;
    dirty.delete(path);
    listings.set(path, beginSlot(listings.get(path) ?? idleSlot(), undefined, token));
    publish();
    let entries: Entries | null = null;
    try {
      const result = await deps.list(path);
      if (result.ok) entries = [...result.data.entries].sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // A failed read keeps what the column showed, like a failed result.
    }
    const slot = listings.get(path);
    if (disposed || !slot || !isSlotCurrent(slot, token)) return;
    if (!entries) {
      listings.set(path, settleSlot(slot, token, { ok: false, error: "listing failed", keepPrevious: true }));
      publish();
      return;
    }
    listings.delete(path);
    listings.set(path, settleSlot(slot, token, { ok: true, data: entries }));
    trimCache();
    publish();
    if (deps.hideEmpty()) void probe(entries);
  }

  function show(paths: readonly string[]): void {
    if (disposed) return;
    const wanted = new Set(paths);
    for (const path of shown) {
      if (wanted.has(path)) continue;
      shown.delete(path);
      deps.cancelScheduled(path, key);
      void watches.get(path)?.destroy();
      watches.delete(path);
      // Its scheduled re-read was cancelled, so the cached copy is stale.
      if (dirty.delete(path)) evict(path);
    }
    for (const path of wanted) {
      shown.add(path);
      if (!watches.has(path)) {
        const watch = deps.createWatch();
        watches.set(path, watch);
        void watch.update(path);
      }
      const slot = listings.get(path);
      if (!slot || slot.kind === "idle" || slot.kind === "failed") void load(path);
    }
  }

  function forgetEmptiness(path: string): void {
    const current = untrack(() => empty);
    const parent = parentDir(path);
    if (!current.flags.has(path) && !current.flags.has(parent)) return;
    const flags = new Map(current.flags);
    flags.delete(path);
    flags.delete(parent);
    empty = { includeHidden: current.includeHidden, flags };
  }

  function watcherChanged(change: DirectoryChange): void {
    if (disposed) return;
    forgetEmptiness(change.path);
    if (!shown.has(change.path)) {
      evict(change.path);
      return;
    }
    dirty.add(change.path);
    deps.schedule(
      () => !disposed && shown.has(change.path) ? load(change.path) : false,
      change.path, true, key, change.observedAt, change.origin,
    );
  }

  function locallyChanged(paths: readonly string[]): void {
    if (disposed) return;
    for (const path of paths) {
      forgetEmptiness(path);
      if (shown.has(path)) void load(path);
      else evict(path);
    }
  }

  async function probe(entries: Entries): Promise<void> {
    const includeHidden = deps.includeHidden();
    const known = untrack(() => empty);
    const flags = known.includeHidden === includeHidden ? known.flags : new Map<string, boolean>();
    const targets = entries.filter((entry) => entry.kind === "directory" && !flags.has(entry.path));
    if (targets.length === 0) return;
    const results = await Promise.all(
      targets.map(async (entry) => [entry.path, await deps.isEmpty(entry.path, includeHidden)] as const),
    );
    // A probe made under the other hidden-file setting answers a different question.
    if (disposed || deps.includeHidden() !== includeHidden) return;
    const current = untrack(() => empty);
    const next = new Map(current.includeHidden === includeHidden ? current.flags : []);
    for (const [path, isEmpty] of results) next.set(path, isEmpty);
    empty = { includeHidden, flags: next };
  }

  const subscription = deps.subscribe(watcherChanged);
  const stopLocal = deps.subscribeLocal(locallyChanged);

  return {
    /** Reconcile the shown columns: watch and read each one, release the rest. */
    show,
    /** The listing a column shows, sorted by name; undefined until it has one. */
    entries(path: string): Entries | undefined {
      const slot = published.get(path);
      return slot && slotData(slot);
    },
    /** Known emptiness of a listed directory under the current hidden-file setting. */
    isEmpty(path: string): boolean | undefined {
      const current = empty;
      return current.includeHidden === deps.includeHidden() ? current.flags.get(path) : undefined;
    },
    /** Back-fill emptiness for every shown column (hide-empty was turned on). */
    probeEmptyFlags(): void {
      for (const path of shown) {
        const entries = slotData(listings.get(path) ?? idleSlot<Entries>());
        if (entries) void probe(entries);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      subscription.stop();
      stopLocal();
      for (const path of shown) deps.cancelScheduled(path, key);
      for (const watch of watches.values()) void watch.destroy();
      watches.clear();
      shown.clear();
    },
  };
}

export type MillerColumns = ReturnType<typeof createMillerColumns>;
