/**
 * Git status state management.
 * Issue: feat/git-status-indicators, fix/git-badges-not-updating (#93)
 *
 * Fetches git status per directory and exposes per-file status indicators.
 * Statuses are keyed by directory (bounded cache) so dual panes showing
 * different directories don't bleed badges into each other. Listens for
 * `git-status-changed` from the Rust watcher to refresh when files change.
 */

import {
  cancelGetGitStatus,
  getGitStatus,
  type GitFileStatus,
} from "$lib/api/files";
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
  /** Directories with a fetch currently in flight, for per-dir loading UI —
   *  distinct from "absent" (never fetched), which reads as no data yet. */
  let loadingDirs = $state<Record<string, boolean>>({});
  let subscribed = false;
  // Real in-flight dedup (#426): a concurrent request for a path already being
  // fetched awaits the SAME promise instead of firing a second IPC call. At
  // startup two consumers (both panes, watcher warm) raced identical fetches,
  // piling up "Git for Windows" processes and ~1GB RAM over the 9P mount.
  interface Flight {
    taskId: number;
    promise: Promise<void>;
    abandoned: boolean;
  }
  const inFlight = new Map<string, Flight>();
  const trackedDirectories = new Map<string, number>();
  /** Settled entries retained after their last pane leaves. They remain
   * displayable, but watcher refreshes skip them until a pane returns. */
  const staleDirectories = new Set<string>();
  const pendingByDir = new Map<string, number>();

  async function fetchForDirectory(path: string): Promise<void> {
    currentPath = path;
    if (byDir[path]) {
      const flight = inFlight.get(path);
      if (flight) {
        console.debug(`[git-status] joining background revalidation for ${path}`);
        await flight.promise;
        return;
      }
      console.debug(`[git-status] cache hit for ${path}`);
      return; // cached; watcher events keep it fresh
    }
    await doFetch(path);
  }

  function doFetch(path: string): Promise<void> {
    const existing = inFlight.get(path);
    if (existing) {
      console.debug(`[git-status] joining in-flight fetch for ${path}`);
      return existing.promise;
    }
    const taskId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const flight = { taskId, promise: Promise.resolve(), abandoned: false };
    flight.promise = performFetch(path, flight).finally(() => {
      if (inFlight.get(path) === flight) inFlight.delete(path);
    });
    inFlight.set(path, flight);
    return flight.promise;
  }

  async function performFetch(path: string, flight: Flight): Promise<void> {
    pendingByDir.set(path, (pendingByDir.get(path) ?? 0) + 1);
    loading = true;
    loadingDirs = { ...loadingDirs, [path]: true };
    const start = performance.now();
    try {
      const result = await getGitStatus(path, flight.taskId);
      const elapsedMs = Math.round(performance.now() - start);
      if (result.ok && !flight.abandoned) {
        console.info(
          `[git-status] fetch for ${path} completed in ${elapsedMs}ms: is_git_repo=${result.data.is_git_repo} entries=${Object.keys(result.data.statuses).length}`,
        );
        const next: Record<string, DirGitStatus> = {
          ...byDir,
          [path]: { isGitRepo: result.data.is_git_repo, statuses: result.data.statuses },
        };
        // Bound recent history without evicting any directory a pane still
        // displays. More than eight concurrently tracked panes may exceed the
        // soft bound; correctness wins until a pane releases.
        const keys = Object.keys(next);
        if (keys.length > MAX_TRACKED_DIRS) {
          for (const key of keys) {
            if (Object.keys(next).length <= MAX_TRACKED_DIRS) break;
            if (key !== path && !trackedDirectories.has(key)) {
              console.debug(`[git-status] evicting tracked dir ${key}`);
              delete next[key];
              staleDirectories.delete(key);
            }
          }
        }
        byDir = next;
      } else if (!result.ok) {
        console.warn(`[git-status] fetch for ${path} failed after ${elapsedMs}ms: ${result.error}`);
      }
    } finally {
      const remaining = (pendingByDir.get(path) ?? 1) - 1;
      if (remaining > 0) {
        pendingByDir.set(path, remaining);
      } else {
        pendingByDir.delete(path);
        const { [path]: _done, ...rest } = loadingDirs;
        loadingDirs = rest;
      }
      loading = pendingByDir.size > 0;
    }
  }

  /**
   * Retain a directory while one pane displays it. The returned release
   * callback is idempotent and cancels an unfinished scan only when the final
   * pane leaves.
   */
  function trackDirectory(path: string): () => void {
    const wasUntracked = !trackedDirectories.has(path);
    trackedDirectories.set(path, (trackedDirectories.get(path) ?? 0) + 1);
    if (wasUntracked && staleDirectories.delete(path) && byDir[path]) {
      // Keep the settled badges visible while refreshing them underneath.
      void doFetch(path);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (trackedDirectories.get(path) ?? 1) - 1;
      if (remaining > 0) {
        trackedDirectories.set(path, remaining);
        return;
      }
      trackedDirectories.delete(path);
      // Preserve settled badges for instant back-navigation, but exclude this
      // directory from watcher-driven work until a pane tracks it again.
      if (byDir[path]) staleDirectories.add(path);
      if (currentPath === path) {
        currentPath = Array.from(trackedDirectories.keys()).at(-1) ?? "";
      }
      const flight = inFlight.get(path);
      if (!flight) return;
      inFlight.delete(path);
      flight.abandoned = true;
      void cancelGetGitStatus(flight.taskId);
    };
  }

  /** Re-fetch all tracked directories (both panes may show different dirs). */
  async function refresh(): Promise<void> {
    const dirs = Object.keys(byDir).filter(
      (path) => trackedDirectories.has(path) || !staleDirectories.has(path),
    );
    if (dirs.length === 0) {
      if (currentPath) {
        console.info(`[git-status] refresh: refetching 1 dir: ${currentPath}`);
        await doFetch(currentPath);
      } else {
        console.info("[git-status] refresh: no tracked dirs to refetch");
      }
      return;
    }
    console.info(`[git-status] refresh: refetching ${dirs.length} dirs: ${dirs.join(", ")}`);
    await Promise.all(dirs.map(doFetch));
  }

  /** Status of an entry, looked up by the directory it lives in. */
  function getStatus(directory: string, fileName: string): GitFileStatus | null {
    return byDir[directory]?.statuses[fileName] ?? null;
  }

  function clear(): void {
    currentPath = "";
    byDir = {};
    staleDirectories.clear();
    trackedDirectories.clear();
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
    /** True while a fetch for `directory` is in flight (distinct from having
     *  no cached data yet). */
    isDirLoading(directory: string): boolean { return loadingDirs[directory] ?? false; },
    trackDirectory,
    fetchForDirectory,
    refresh,
    getStatus,
    clear,
    initWatcherListener,
  };
}

export const gitStatusStore = createGitStatusStore();
