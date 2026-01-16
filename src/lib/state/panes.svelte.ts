/**
 * Pane management state for dual pane layout.
 * Tracks active pane, layout configuration, and pane switching.
 */

import type { PaneId, PaneLayoutState } from "./types";
import type { ExplorerInstance } from "./explorer.svelte";

function createPaneManager() {
  let state = $state<PaneLayoutState>({
    activePaneId: "left",
    splitRatio: 0.5,
    dualPaneEnabled: false,
  });

  // Explorer instance registry for command access
  const explorers = new Map<PaneId, ExplorerInstance>();

  function registerExplorer(paneId: PaneId, explorer: ExplorerInstance) {
    explorers.set(paneId, explorer);
  }

  function unregisterExplorer(paneId: PaneId) {
    explorers.delete(paneId);
  }

  function getActivePane(): ExplorerInstance | undefined {
    return explorers.get(state.activePaneId);
  }

  function getPane(paneId: PaneId): ExplorerInstance | undefined {
    return explorers.get(paneId);
  }

  function setActivePane(paneId: PaneId) {
    state.activePaneId = paneId;
  }

  function toggleDualPane() {
    state.dualPaneEnabled = !state.dualPaneEnabled;
    // If disabling, reset to left pane
    if (!state.dualPaneEnabled) {
      state.activePaneId = "left";
    }
  }

  function enableDualPane() {
    state.dualPaneEnabled = true;
  }

  function disableDualPane() {
    state.dualPaneEnabled = false;
    state.activePaneId = "left";
  }

  function setSplitRatio(ratio: number) {
    state.splitRatio = Math.max(0.2, Math.min(0.8, ratio));
  }

  function switchPane() {
    if (!state.dualPaneEnabled) return;
    state.activePaneId = state.activePaneId === "left" ? "right" : "left";
  }

  return {
    get state() {
      return state;
    },
    get activePaneId() {
      return state.activePaneId;
    },
    get dualPaneEnabled() {
      return state.dualPaneEnabled;
    },
    get splitRatio() {
      return state.splitRatio;
    },
    setActivePane,
    toggleDualPane,
    enableDualPane,
    disableDualPane,
    setSplitRatio,
    switchPane,
    registerExplorer,
    unregisterExplorer,
    getActivePane,
    getPane,
  };
}

export const paneManager = createPaneManager();
