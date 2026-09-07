/**
 * Composable for file change and event listeners.
 *
 * Manages: cross-window BroadcastChannel file change listener,
 * and Tauri "directory-changed" filesystem watcher events.
 */

import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { directoryEvents, type DirectorySubscription } from "$lib/state/directory-events";
import { initFileChangeListener, cleanupFileChangeListener, subscribeToLocalFileChanges } from "$lib/state/file-events";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { settingsStore } from "$lib/state/settings.svelte";
import { gitStatusStore } from "$lib/state/git-status.svelte";
import { repoRootCache } from "$lib/state/repo-root-cache.svelte";
import { subscribeGitChanges } from "$lib/state/git-refresh";

export interface FileWatcherDeps {
  getAllExplorers: () => ExplorerInstance[];
}

export function useFileWatchers(deps: FileWatcherDeps) {
  let directorySubscription: DirectorySubscription | undefined;
  let stopLocalInvalidation: (() => void) | undefined;
  let stopGitInvalidation: (() => void) | undefined;
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
    stopLocalInvalidation = subscribeToLocalFileChanges((paths) => {
      for (const path of paths) repoRootCache.invalidate(path);
    });
    void subscribeGitChanges((change) => repoRootCache.invalidate(change.repoRoot ?? undefined)).then(
      track((fn) => { stopGitInvalidation = fn; }),
      () => {},
    );
    // Listen for file changes from other windows. Refresh every explorer
    // (including inactive tabs) whose current path is in affectedDirs so
    // the source tab sees the change without needing to be activated.
    initFileChangeListener((affectedDirs) => {
      for (const exp of deps.getAllExplorers()) {
        for (const path of affectedDirs) exp.directoryChanged({ path });
      }
    });

    // Pane owners receive the same event before their first scan. This window
    // subscription owns repository invalidation and badge refresh only.
    directorySubscription = directoryEvents.subscribe(({ path }) => {
      repoRootCache.invalidate(path);
      if (settingsStore.showGitStatus && gitStatusStore.currentPath === path) {
        gitStatusStore.refresh();
      }
    });
    void directorySubscription.ready().catch(() => {
      // Native navigation surfaces subscription failures and retries on demand.
    });
  }

  function cleanup(): void {
    disposed = true;
    cancelPendingRefreshes();
    cleanupFileChangeListener();
    stopLocalInvalidation?.();
    stopLocalInvalidation = undefined;
    stopGitInvalidation?.();
    stopGitInvalidation = undefined;
    directorySubscription?.stop();
    directorySubscription = undefined;
  }

  return { setup, cleanup };
}
