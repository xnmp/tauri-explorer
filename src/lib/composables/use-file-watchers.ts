/**
 * Composable for file change and event listeners.
 *
 * Manages: cross-window BroadcastChannel file change listener,
 * Tauri "directory-changed" filesystem watcher events,
 * and Nano Banana completion/error events.
 */

import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { initFileChangeListener, cleanupFileChangeListener } from "$lib/state/file-events";
import { requestRefresh, cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { basename } from "$lib/domain/path";
import { jobsStore } from "$lib/state/jobs.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { settingsStore } from "$lib/state/settings.svelte";
import { gitStatusStore } from "$lib/state/git-status.svelte";

export interface FileWatcherDeps {
  getAllExplorers: () => ExplorerInstance[];
  refreshAllPanes: () => void;
}

export function useFileWatchers(deps: FileWatcherDeps) {
  let unlistenWatcher: UnlistenFn | undefined;
  let unlistenNbComplete: UnlistenFn | undefined;
  let unlistenNbError: UnlistenFn | undefined;
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

    // Listen for Nano Banana completion/error events
    listen<{ jobId: number; outputPath: string }>("nano-banana-complete", (event) => {
      const { jobId, outputPath } = event.payload;
      jobsStore.completeJob(jobId, outputPath);
      const fileName = basename(outputPath);
      toastStore.show(`Nano Banana complete: ${fileName}`, "success");
      deps.refreshAllPanes();
    }).then(track((fn) => { unlistenNbComplete = fn; }));

    listen<{ jobId: number; error: string }>("nano-banana-error", (event) => {
      const { jobId, error } = event.payload;
      jobsStore.failJob(jobId, error);
      toastStore.error(`Nano Banana failed: ${error.slice(0, 100)}`);
    }).then(track((fn) => { unlistenNbError = fn; }));

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
    unlistenNbComplete?.();
    unlistenNbError?.();
  }

  return { setup, cleanup };
}
