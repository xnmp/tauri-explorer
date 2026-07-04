/**
 * Composable for file change and event listeners.
 *
 * Manages: cross-window BroadcastChannel file change listener,
 * and Tauri "directory-changed" filesystem watcher events.
 */

import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { initFileChangeListener, cleanupFileChangeListener } from "$lib/state/file-events";
import { requestRefresh, cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { settingsStore } from "$lib/state/settings.svelte";
import { gitStatusStore } from "$lib/state/git-status.svelte";

export interface FileWatcherDeps {
  getAllExplorers: () => ExplorerInstance[];
}

export function useFileWatchers(deps: FileWatcherDeps) {
  let unlistenWatcher: UnlistenFn | undefined;
  // Guards against cleanup() racing the async listen() registrations:
  // if cleanup runs before a registration resolves, unlisten on arrival.
  let disposed = false;

  /** Store an unlisten fn, or invoke it immediately if already cleaned up. */
  function track(assign: (fn: UnlistenFn) => void): (fn: UnlistenFn) => void {
    return (fn) => {
      if (disposed) {
        fn();
        return;
      }
      assign(fn);
    };
  }

  function setup(): void {
    disposed = false;
    // Listen for file changes from other windows. Refresh every explorer
    // (including inactive tabs) whose current path is in affectedDirs so
    // the source tab sees the change without needing to be activated.
    initFileChangeListener((affectedDirs) => {
      for (const exp of deps.getAllExplorers()) {
        if (affectedDirs.includes(exp.currentPath)) {
          requestRefresh((opts) => exp.refresh(opts), exp.currentPath);
        }
      }
    });

    // Listen for filesystem watcher events from backend (auto-refresh)
    listen<{ path: string }>("directory-changed", (event) => {
      const changedPath = event.payload.path;
      for (const exp of deps.getAllExplorers()) {
        if (exp.currentPath === changedPath) {
          requestRefresh((opts) => exp.refresh(opts), exp.currentPath);
        }
      }
      // Also refresh git status badges for the changed directory
      if (settingsStore.showGitStatus && gitStatusStore.currentPath === changedPath) {
        gitStatusStore.refresh();
      }
    }).then(track((fn) => { unlistenWatcher = fn; }));
  }

  function cleanup(): void {
    disposed = true;
    cancelPendingRefreshes();
    cleanupFileChangeListener();
    unlistenWatcher?.();
  }

  return { setup, cleanup };
}
