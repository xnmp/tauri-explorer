/**
 * Git status state management.
 * Issue: feat/git-status-indicators, fix/git-badges-not-updating (#93)
 *
 * Fetches git status per directory and exposes per-file status indicators.
 * Statuses are keyed by directory (bounded cache) so dual panes showing
 * different directories don't bleed badges into each other. Listens for
 * `git-status-changed` from the Rust watcher to refresh when files change.
 */

import { getGitStatus, type GitFileStatus } from "$lib/api/files";
import { subscribeGitChanges } from "./git-refresh";

interface DirGitStatus {
  isGitRepo: boolean;
  statuses: Record<string, GitFileStatus>;
}

/** Max directories to keep statuses for (panes + recently visited dirs). */
const MAX_TRACKED_DIRS = 8;

function createGitStatusStore() {
  /** Per-directory status maps, insertion-ordered for bounded eviction. */
  let byDir = $state<Record<string, DirGitStatus>>({});
  /** Most recently requested directory (kept for watcher compatibility). */
  let currentPath = $state<string>("");
  let loading = $state(false);
  let subscribed = false;
  // Count of in-flight doFetch calls. refresh() fans out concurrently via
  // Promise.all, so `loading` must stay true until ALL of them settle — a
  // plain boolean would get cleared by whichever fetch finishes first while
  // its siblings are still in flight.
  let pendingFetches = 0;

  async function fetchForDirectory(path: string): Promise<void> {
    currentPath = path;
    if (byDir[path]) return; // cached; watcher events keep it fresh
    await doFetch(path);
  }

  async function doFetch(path: string): Promise<void> {
    pendingFetches++;
    loading = true;
    try {
      const result = await getGitStatus(path);
      if (result.ok) {
        const next: Record<string, DirGitStatus> = {
          ...byDir,
          [path]: { isGitRepo: result.data.is_git_repo, statuses: result.data.statuses },
        };
        // Bound the cache: evict oldest entries that aren't the active dir.
        const keys = Object.keys(next);
        if (keys.length > MAX_TRACKED_DIRS) {
          for (const key of keys) {
            if (Object.keys(next).length <= MAX_TRACKED_DIRS) break;
            if (key !== path && key !== currentPath) delete next[key];
          }
        }
        byDir = next;
      }
    } finally {
      pendingFetches--;
      loading = pendingFetches > 0;
    }
  }

  /** Re-fetch all tracked directories (both panes may show different dirs). */
  async function refresh(): Promise<void> {
    const dirs = Object.keys(byDir);
    if (dirs.length === 0) {
      if (currentPath) await doFetch(currentPath);
      return;
    }
    await Promise.all(dirs.map(doFetch));
  }

  /** Status of an entry, looked up by the directory it lives in. */
  function getStatus(directory: string, fileName: string): GitFileStatus | null {
    return byDir[directory]?.statuses[fileName] ?? null;
  }

  function clear(): void {
    currentPath = "";
    byDir = {};
  }

  async function initWatcherListener(): Promise<void> {
    if (subscribed) return;
    subscribed = true;
    // Badges refresh on every git change, whether from the backend watcher
    // or a local action (stage/commit/discard in the SCM panel).
    await subscribeGitChanges(() => {
      void refresh();
    });
  }

  return {
    get isGitRepo() { return byDir[currentPath]?.isGitRepo ?? false; },
    get loading() { return loading; },
    get currentPath() { return currentPath; },
    fetchForDirectory,
    refresh,
    getStatus,
    clear,
    initWatcherListener,
  };
}

export const gitStatusStore = createGitStatusStore();
