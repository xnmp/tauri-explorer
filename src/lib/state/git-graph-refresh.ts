/**
 * Git-graph refresh bus (#432).
 *
 * F5 used to be a shadow keybinding inside GitGraphView's own
 * `<svelte:window onkeydown>` — invisible to the keybindings registry, so the
 * terminal key-ownership gate could never know the graph "owned" F5, and the
 * listener fired for every mounted graph tab whether active or not.
 *
 * Instead, `gitGraph.refresh` is now a real registered command (F5, gated on
 * the active pane showing a graph). GitGraphView registers its own
 * fetch+reload handler here keyed by pane id; the command dispatches to the
 * ACTIVE pane's handler only. No component-level global key listener.
 */

type RefreshFn = () => void;

export interface ReloaderContext {
  generation: number;
  isCurrent(): boolean;
}

export interface Reloader {
  readonly generation: number;
  reload(): Promise<void>;
}

/**
 * Serializes graph reloads without dropping a request made during an active
 * fetch. Consumers use `isCurrent` before applying asynchronous results and
 * use `generation` to reject a page appended by an older graph query.
 */
export function createReloader(fetchFn: (context: ReloaderContext) => Promise<void>): Reloader {
  let generation = 0;
  let reloading = false;
  let reloadDirty = false;

  const reload = async (): Promise<void> => {
    if (reloading) {
      reloadDirty = true;
      return;
    }

    reloading = true;
    reloadDirty = false;
    const currentGeneration = ++generation;
    try {
      await fetchFn({
        generation: currentGeneration,
        isCurrent: () => currentGeneration === generation,
      });
    } finally {
      reloading = false;
      if (reloadDirty) void reload();
    }
  };

  return {
    get generation() {
      return generation;
    },
    reload,
  };
}

/** A graph action reloads itself, so it ignores its matching local event. */
export function shouldReloadGraphForChange(change: { source: "watcher" | "local" }): boolean {
  return change.source !== "local";
}

/** Stash rows are woven into the graph but are not git-walk pagination steps. */
export function countGraphWalkCommits<T extends { stash?: unknown }>(
  commits: ReadonlyArray<T>,
): number {
  return commits.filter((commit) => !commit.stash).length;
}

const refreshers = new Map<string, RefreshFn>();

/** Register a pane's graph refresh handler. Returns an unregister fn; call it
 *  on unmount. Idempotent per pane — a remount replaces the prior handler. */
export function registerGraphRefresher(paneId: string, fn: RefreshFn): () => void {
  refreshers.set(paneId, fn);
  return () => {
    if (refreshers.get(paneId) === fn) refreshers.delete(paneId);
  };
}

/** Trigger the refresh handler for one pane (the active graph pane). No-op
 *  when the pane has no registered graph. */
export function refreshGraphPane(paneId: string | undefined | null): boolean {
  if (!paneId) return false;
  const fn = refreshers.get(paneId);
  if (!fn) return false;
  fn();
  return true;
}
