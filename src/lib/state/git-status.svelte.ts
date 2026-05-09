/**
 * Git status state management.
 * Issue: feat/git-status-indicators, fix/git-badges-not-updating (#93)
 *
 * Fetches git status for the current directory and exposes
 * per-file status indicators. Listens for `git-status-changed`
 * from the Rust watcher to refresh when files change.
 */

import { getGitStatus, type GitFileStatus } from "$lib/api/files";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

function createGitStatusStore() {
  let currentPath = $state<string>("");
  let isGitRepo = $state(false);
  let statuses = $state<Record<string, GitFileStatus>>({});
  let loading = $state(false);
  let unlistenWatcher: UnlistenFn | null = null;

  async function fetchForDirectory(path: string): Promise<void> {
    if (path === currentPath && Object.keys(statuses).length > 0) return;
    currentPath = path;
    await doFetch(path);
  }

  async function doFetch(path: string): Promise<void> {
    loading = true;
    const result = await getGitStatus(path);
    if (result.ok && currentPath === path) {
      isGitRepo = result.data.is_git_repo;
      statuses = result.data.statuses;
    }
    loading = false;
  }

  async function refresh(): Promise<void> {
    if (!currentPath) return;
    await doFetch(currentPath);
  }

  function getStatus(fileName: string): GitFileStatus | null {
    return statuses[fileName] ?? null;
  }

  function clear(): void {
    currentPath = "";
    isGitRepo = false;
    statuses = {};
  }

  async function initWatcherListener(): Promise<void> {
    if (unlistenWatcher) return;
    try {
      unlistenWatcher = await listen<string>("git-status-changed", () => {
        if (currentPath) {
          refresh();
        }
      });
    } catch {
      // Listener attach fails gracefully in non-Tauri contexts (E2E browser).
    }
  }

  return {
    get isGitRepo() { return isGitRepo; },
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
