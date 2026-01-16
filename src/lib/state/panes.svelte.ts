/**
 * Pane management state for dual pane layout.
 * Tracks active pane, layout configuration, and pane switching.
 */

import type { PaneId, PaneLayoutState } from "./types";

function createPaneManager() {
  let state = $state<PaneLayoutState>({
    activePaneId: "left",
    splitRatio: 0.5,
    dualPaneEnabled: false,
  });

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
  };
}

export const paneManager = createPaneManager();
