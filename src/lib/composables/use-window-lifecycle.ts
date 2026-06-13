/**
 * Composable for window lifecycle event handlers.
 *
 * Manages: focus persistence, native context menu suppression,
 * beforeunload tab save, and periodic tab save interval.
 */

import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { saveFocusedWindowState } from "$lib/state/focused-window";

export interface WindowLifecycleDeps {
  getActiveExplorer: () => ExplorerInstance | undefined;
  saveTabs: () => void;
}

const SAVE_INTERVAL_MS = 30000;

export function useWindowLifecycle(deps: WindowLifecycleDeps) {
  let saveInterval: ReturnType<typeof setInterval> | undefined;

  function persistFocusedState() {
    const explorer = deps.getActiveExplorer();
    if (explorer) {
      saveFocusedWindowState(explorer.currentPath, explorer.viewMode);
    }
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  function handleBeforeUnload() {
    deps.saveTabs();
  }

  function setup(): void {
    window.addEventListener("focus", persistFocusedState);
    window.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("beforeunload", handleBeforeUnload);
    saveInterval = setInterval(() => {
      deps.saveTabs();
    }, SAVE_INTERVAL_MS);
  }

  function cleanup(): void {
    window.removeEventListener("focus", persistFocusedState);
    window.removeEventListener("contextmenu", handleContextMenu);
    window.removeEventListener("beforeunload", handleBeforeUnload);
    if (saveInterval !== undefined) {
      clearInterval(saveInterval);
      saveInterval = undefined;
    }
  }

  return { setup, cleanup, persistFocusedState };
}
