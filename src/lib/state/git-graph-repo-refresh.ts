/**
 * Live refresh for a mounted git graph (#365, #432): watch the repository and
 * reload when git state changes underneath it. Local mutations (this app's
 * own actions) refresh directly through the graph's reloader and are
 * filtered out by `shouldReloadGraphForChange`, so an action's notify echo
 * does not cause a second reload. A short trailing debounce folds the watcher
 * burst a pull produces into one call; the reloader never drops a request.
 */
import { directoryKey } from "$lib/domain/path";
import { shouldReloadGraphForChange } from "./git-graph-refresh";
import { subscribeGitChanges } from "./git-refresh";
import { createGitRepoWatch } from "./git-repo-watch";

export interface GraphRepoRefreshHandlers {
  /** Runs at observation time, before the trailing reload. */
  onObserved: () => void;
  reload: () => void;
}

export const GRAPH_REPO_REFRESH_DELAY_MS = 300;

/** Start watching `repo`; the returned function stops the watch, the
 *  subscription and any pending trailing reload. */
export function watchGraphRepository(repo: string, handlers: GraphRepoRefreshHandlers): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const watch = createGitRepoWatch();
  void watch.update(repo);
  void subscribeGitChanges((change) => {
    if (!shouldReloadGraphForChange(change)) return;
    if (change.repoRoot && directoryKey(change.repoRoot) !== directoryKey(repo)) return;
    handlers.onObserved();
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!disposed) handlers.reload();
    }, GRAPH_REPO_REFRESH_DELAY_MS);
  }).then((u) => {
    if (disposed) u();
    else unsubscribe = u;
  });
  return () => {
    disposed = true;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    unsubscribe?.();
    void watch.destroy();
  };
}
