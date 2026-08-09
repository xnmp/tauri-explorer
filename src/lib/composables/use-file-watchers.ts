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
import { e2eMode } from "$lib/e2e-mode";

export interface FileWatcherDeps {
  getAllExplorers: () => ExplorerInstance[];
}

interface WatcherReceipt {
  count: number;
  observedAt: number | null;
}

const watcherReceipts = new Map<string, WatcherReceipt>();

function publishWatcherListenerReady(): void {
  if (!e2eMode || typeof document === "undefined") return;
  document.documentElement.dataset.e2eDirectoryWatcherListenerReady = "true";
}

function publishWatcherReceipt(path: string, observedAt: number | undefined): void {
  if (!e2eMode || typeof document === "undefined") return;
  const previous = watcherReceipts.get(path);
  watcherReceipts.set(path, {
    count: (previous?.count ?? 0) + 1,
    observedAt: observedAt ?? null,
  });
  document.documentElement.dataset.e2eDirectoryWatcherReceipts = JSON.stringify(
    Object.fromEntries(watcherReceipts),
  );
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
        const watchedPath = exp.currentPath;
        if (affectedDirs.includes(watchedPath)) {
          requestRefresh(
            (opts) => {
              if (exp.currentPath !== watchedPath) return;
              return exp.refresh(opts);
            },
            watchedPath,
            true,
            exp,
          );
        }
      }
    });

    // Listen for filesystem watcher events from backend (auto-refresh).
    // Outside Tauri the event system is unavailable and listen() throws
    // (same guard as state/drives.svelte.ts); refresh still works manually.
    try {
      listen<{ path: string; observed_at_ms?: number }>("directory-changed", (event) => {
        const changedPath = event.payload.path;
        publishWatcherReceipt(changedPath, event.payload.observed_at_ms);
        for (const exp of deps.getAllExplorers()) {
          if (exp.currentPath === changedPath) {
            requestRefresh(
              (opts) => {
                if (exp.currentPath !== changedPath) return;
                return exp.refresh(opts);
              },
              changedPath,
              true,
              exp,
              event.payload.observed_at_ms,
            );
          }
        }
        // Also refresh git status badges for the changed directory
        if (settingsStore.showGitStatus && gitStatusStore.currentPath === changedPath) {
          gitStatusStore.refresh();
        }
      }).then(
        track((fn) => {
          unlistenWatcher = fn;
          publishWatcherListenerReady();
        }),
        () => {},
      );
    } catch {
      // Not running under Tauri — no backend watcher events to subscribe to.
    }
  }

  function cleanup(): void {
    disposed = true;
    cancelPendingRefreshes();
    cleanupFileChangeListener();
    unlistenWatcher?.();
  }

  return { setup, cleanup };
}
