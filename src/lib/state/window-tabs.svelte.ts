/**
 * Window-level tabs state management.
 * Issue: tauri-explorer-ldfx
 *
 * Each tab contains the full dual-pane layout state. The tab bar is at
 * window level, and each tab independently tracks:
 * - Left and right pane explorer states
 * - Active pane (left/right)
 * - Dual pane enabled/disabled
 * - Split ratio (divider position)
 */

import type { PaneId, WindowTab, WindowTabPane } from "./types";
import { createExplorerState, type ExplorerInstance } from "./explorer.svelte";
import { loadPersisted, savePersisted } from "./persisted";

const STORAGE_KEY = "explorer-tabs";
const CLOSED_TABS_KEY = "explorer-closed-tabs";

/** Serializable tab state for persistence */
export interface PersistedPane {
  path: string;
}

export interface PersistedTab {
  id: string;
  panes: {
    left: PersistedPane;
    right: PersistedPane;
  };
  activePaneId: PaneId;
  dualPaneEnabled: boolean;
  splitRatio: number;
}

export interface PersistedTabState {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

/** Generate unique IDs for tabs and explorers */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Extract folder name from path for tab title */
export function extractFolderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path || "Explorer";
}

/** Snapshot of a closed tab for restoration via Ctrl+Shift+T */
interface ClosedTabSnapshot {
  leftPath: string;
  rightPath: string;
  activePaneId: PaneId;
  dualPaneEnabled: boolean;
  splitRatio: number;
  closedAt: number; // insertion index
  fromClosedWindow: boolean; // true if this was the last tab when window closed
}

const MAX_CLOSED_TABS = 20;

/** Result of restoring a closed tab */
export interface RestoreResult {
  restored: true;
  /** If the closed tab was from a closed window, the path to open in a new window */
  openInNewWindow?: string;
}

function createWindowTabsManager() {
  // Explorer instances registry (keyed by explorerId)
  const explorers = new Map<string, ExplorerInstance>();

  // Window tabs state
  let tabs = $state<WindowTab[]>([]);
  let activeTabId = $state<string | null>(null);

  // Stack of recently closed tabs for Ctrl+Shift+T restoration (persisted)
  const closedTabStack: ClosedTabSnapshot[] = loadPersisted<ClosedTabSnapshot[]>(CLOSED_TABS_KEY, []);

  /** Persist the closed tab stack to localStorage */
  function saveClosedTabs(): void {
    savePersisted(CLOSED_TABS_KEY, closedTabStack);
  }

  /** Capture the current tab state as a serializable snapshot */
  function captureState(): PersistedTabState {
    const persistedTabs: PersistedTab[] = tabs.map((tab) => ({
      id: tab.id,
      panes: {
        left: { path: getPanePath(tab.panes.left) },
        right: { path: getPanePath(tab.panes.right) },
      },
      activePaneId: tab.activePaneId,
      dualPaneEnabled: tab.dualPaneEnabled,
      splitRatio: tab.splitRatio,
    }));

    return { tabs: persistedTabs, activeTabId };
  }

  /** Save current tab state to localStorage */
  function saveState(): void {
    savePersisted(STORAGE_KEY, captureState());
  }

  /** Load tab state from localStorage */
  function loadState(): PersistedTabState | null {
    return loadPersisted<PersistedTabState | null>(STORAGE_KEY, null);
  }

  /** Get the currently active tab */
  const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? null);

  /** Get tab title (shows active pane's folder name) - derived from explorer's current path */
  function getTabTitle(tab: WindowTab): string {
    const pane = tab.panes[tab.activePaneId];
    const explorer = explorers.get(pane.explorerId);
    if (!explorer) return pane.title || "Explorer";
    return extractFolderName(explorer.currentPath);
  }

  /** Get path for a pane from its explorer */
  function getPanePath(pane: WindowTabPane): string {
    const explorer = explorers.get(pane.explorerId);
    return explorer?.state.currentPath ?? pane.path;
  }

  /** Get tooltip for tab (shows both pane paths when dual-pane) */
  function getTabTooltip(tab: WindowTab): string {
    if (!tab.dualPaneEnabled) {
      return getPanePath(tab.panes[tab.activePaneId]);
    }
    return `Left: ${getPanePath(tab.panes.left)}\nRight: ${getPanePath(tab.panes.right)}`;
  }

  /** Create a new explorer and register it */
  function createAndRegisterExplorer(path: string): { explorerId: string; explorer: ExplorerInstance } {
    const explorerId = generateId("explorer");
    const explorer = createExplorerState();
    explorers.set(explorerId, explorer);
    explorer.navigateTo(path);
    return { explorerId, explorer };
  }

  /** Create a pane object with a new explorer */
  function createPane(path: string): WindowTabPane {
    const { explorerId } = createAndRegisterExplorer(path);
    return {
      explorerId,
      path,
      title: extractFolderName(path),
    };
  }

  /** Create a new window tab */
  function createTab(initialPath?: string): WindowTab {
    const defaultPath = "/home";

    // Inherit paths from active tab's explorers, or use provided/default path
    const leftPath = initialPath ?? (activeTab ? getPanePath(activeTab.panes.left) : defaultPath);
    const rightPath = activeTab ? getPanePath(activeTab.panes.right) : defaultPath;

    const tab: WindowTab = {
      id: generateId("tab"),
      panes: {
        left: createPane(leftPath),
        right: createPane(rightPath),
      },
      activePaneId: "left",
      dualPaneEnabled: activeTab?.dualPaneEnabled ?? false,
      splitRatio: activeTab?.splitRatio ?? 0.5,
    };

    // Insert after active tab or at end
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : tabs.length;

    const newTabs = [...tabs];
    newTabs.splice(insertIndex, 0, tab);
    tabs = newTabs;
    activeTabId = tab.id;
    saveState();

    return tab;
  }

  /** Restore tabs from a persisted state.
   *  @param overridePath - If set, the active pane of the active tab
   *    navigates here instead of its saved path (avoids racing navigations). */
  function restoreFromState(state: PersistedTabState, overridePath?: string): void {
    explorers.clear();

    const restoredTabs: WindowTab[] = state.tabs.map((persistedTab) => {
      const isActiveTab = persistedTab.id === state.activeTabId;
      const activePaneSide = persistedTab.activePaneId ?? "left";

      const leftPath = (isActiveTab && activePaneSide === "left" && overridePath)
        ? overridePath
        : persistedTab.panes.left.path;
      const rightPath = (isActiveTab && activePaneSide === "right" && overridePath)
        ? overridePath
        : persistedTab.panes.right.path;

      const tab: WindowTab = {
        id: persistedTab.id,
        panes: {
          left: createPane(leftPath),
          right: createPane(rightPath),
        },
        activePaneId: persistedTab.activePaneId,
        dualPaneEnabled: persistedTab.dualPaneEnabled,
        splitRatio: persistedTab.splitRatio,
      };
      return tab;
    });

    tabs = restoredTabs;
    activeTabId = state.activeTabId;
  }

  /** Initialize - restores from localStorage or creates a new tab.
   *  @param skipRestore - When true, skip saved-state restoration and
   *    create a fresh tab at initialPath. Used for child windows spawned
   *    via Ctrl+N that receive their path via URL params.
   *  @param overridePath - When set, the active pane navigates here instead
   *    of its saved path. Used for CLI cwd so we don't race two navigations. */
  function init(initialPath: string, skipRestore = false, overridePath?: string): WindowTab {
    if (!skipRestore) {
      // Try to restore from localStorage (cold start / app relaunch)
      const savedState = loadState();
      if (savedState && savedState.tabs.length > 0) {
        restoreFromState(savedState, overridePath);
        const restored = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
        if (restored && !activeTabId) {
          activeTabId = restored.id;
        }
        return restored;
      }
    }

    // No saved state or child window — create a fresh tab
    explorers.clear();
    tabs = [];
    activeTabId = null;
    return createTab(overridePath ?? initialPath);
  }

  /** Snapshot a tab for Ctrl+Shift+T restoration */
  function snapshotTab(tab: WindowTab, tabIndex: number, fromClosedWindow = false): void {
    closedTabStack.push({
      leftPath: getPanePath(tab.panes.left),
      rightPath: getPanePath(tab.panes.right),
      activePaneId: tab.activePaneId,
      dualPaneEnabled: tab.dualPaneEnabled,
      splitRatio: tab.splitRatio,
      closedAt: tabIndex,
      fromClosedWindow,
    });
    if (closedTabStack.length > MAX_CLOSED_TABS) {
      closedTabStack.shift();
    }
    saveClosedTabs();
  }

  /** Close a tab by ID. Closes the window if it's the last tab. */
  function closeTab(tabId: string): void {
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];

    const isLastTab = tabs.length <= 1;

    // Snapshot before closing (even if it's the last tab)
    snapshotTab(tab, tabIndex, isLastTab);

    if (isLastTab) {
      // Close the window when closing the last tab
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch(() => {}); // Not in Tauri runtime
      return;
    }

    // Clean up explorers for this tab
    explorers.delete(tab.panes.left.explorerId);
    explorers.delete(tab.panes.right.explorerId);

    const newTabs = tabs.filter((t) => t.id !== tabId);

    // Update active tab if closing the active one
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      const newIndex = Math.max(0, tabIndex - 1);
      newActiveId = newTabs[newIndex]?.id ?? null;
    }

    tabs = newTabs;
    activeTabId = newActiveId;
    saveState();
  }

  /** Restore the most recently closed tab. Returns false if nothing to restore. */
  function restoreClosedTab(): false | RestoreResult {
    const snapshot = closedTabStack.pop();
    if (!snapshot) return false;
    saveClosedTabs();

    // If the tab was from a closed window, signal to open a new window instead
    if (snapshot.fromClosedWindow) {
      return { restored: true, openInNewWindow: snapshot.leftPath };
    }

    const tab: WindowTab = {
      id: generateId("tab"),
      panes: {
        left: createPane(snapshot.leftPath),
        right: createPane(snapshot.rightPath),
      },
      activePaneId: snapshot.activePaneId,
      dualPaneEnabled: snapshot.dualPaneEnabled,
      splitRatio: snapshot.splitRatio,
    };

    // Insert at the original position (or end if tabs have been rearranged)
    const insertIndex = Math.min(snapshot.closedAt, tabs.length);
    const newTabs = [...tabs];
    newTabs.splice(insertIndex, 0, tab);
    tabs = newTabs;
    activeTabId = tab.id;
    saveState();
    return { restored: true };
  }

  /** Close the active tab */
  function closeActiveTab(): void {
    if (activeTabId) {
      closeTab(activeTabId);
    }
  }

  /** Set the active tab */
  function setActiveTab(tabId: string): void {
    if (tabs.some((t) => t.id === tabId)) {
      activeTabId = tabId;
      saveState();
    }
  }

  /** Move to next tab (wraps around) */
  function nextTab(): void {
    if (tabs.length <= 1) return;

    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    const nextIndex = (currentIndex + 1) % tabs.length;
    activeTabId = tabs[nextIndex].id;
    saveState();
  }

  /** Move to previous tab (wraps around) */
  function prevTab(): void {
    if (tabs.length <= 1) return;

    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    activeTabId = tabs[prevIndex].id;
    saveState();
  }

  /** Get explorer instance for a pane in the active tab */
  function getExplorer(paneId: PaneId): ExplorerInstance | undefined {
    if (!activeTab) return undefined;
    return explorers.get(activeTab.panes[paneId].explorerId);
  }

  /** Get the active explorer (from active pane in active tab) */
  function getActiveExplorer(): ExplorerInstance | undefined {
    if (!activeTab) return undefined;
    return getExplorer(activeTab.activePaneId);
  }

  /** Update the active tab with partial changes */
  function updateActiveTab(updates: Partial<WindowTab>): void {
    if (!activeTabId) return;
    tabs = tabs.map((t) => (t.id === activeTabId ? { ...t, ...updates } : t));
    saveState();
  }

  /** Set the active pane in the active tab */
  function setActivePane(paneId: PaneId): void {
    if (activeTab?.activePaneId === paneId) return;
    updateActiveTab({ activePaneId: paneId });
  }

  /** Switch to the other pane in the active tab */
  function switchPane(): void {
    if (!activeTab?.dualPaneEnabled) return;
    setActivePane(activeTab.activePaneId === "left" ? "right" : "left");
  }

  /** Toggle dual pane mode in the active tab */
  function toggleDualPane(): void {
    if (!activeTab) return;
    const enabling = !activeTab.dualPaneEnabled;
    updateActiveTab({
      dualPaneEnabled: enabling,
      activePaneId: enabling ? activeTab.activePaneId : "left",
    });

    // When enabling dual pane, if right pane shows same path as left,
    // navigate it to the parent directory for a more useful default
    if (enabling) {
      const leftExplorer = getExplorer("left");
      const rightExplorer = getExplorer("right");
      if (leftExplorer && rightExplorer) {
        const leftPath = leftExplorer.state.currentPath;
        const rightPath = rightExplorer.state.currentPath;
        if (leftPath === rightPath) {
          const parentPath = leftPath.substring(0, leftPath.lastIndexOf("/")) || "/";
          rightExplorer.navigateTo(parentPath);
        }
      }
    }
  }

  /** Set dual pane mode in the active tab */
  function setDualPane(enabled: boolean): void {
    if (!activeTab || activeTab.dualPaneEnabled === enabled) return;
    toggleDualPane();
  }

  /** Set split ratio in the active tab */
  function setSplitRatio(ratio: number): void {
    updateActiveTab({ splitRatio: Math.max(0.2, Math.min(0.8, ratio)) });
  }

  /** Reorder tabs */
  function reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= tabs.length) return;
    if (toIndex < 0 || toIndex >= tabs.length) return;
    if (fromIndex === toIndex) return;

    const newTabs = [...tabs];
    const [moved] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, moved);

    tabs = newTabs;
    saveState();
  }

  return {
    // State getters
    get tabs() {
      return tabs;
    },
    get activeTabId() {
      return activeTabId;
    },
    get activeTab() {
      return activeTab;
    },

    // Derived state for active tab
    get activePaneId() {
      return activeTab?.activePaneId ?? "left";
    },
    get dualPaneEnabled() {
      return activeTab?.dualPaneEnabled ?? false;
    },
    get splitRatio() {
      return activeTab?.splitRatio ?? 0.5;
    },

    // Tab operations
    init,
    createTab,
    closeTab,
    closeActiveTab,
    restoreClosedTab,
    get canRestoreTab() {
      return closedTabStack.length > 0;
    },
    setActiveTab,
    nextTab,
    prevTab,
    reorderTabs,
    getTabTitle,
    getTabTooltip,

    // Explorer access
    getExplorer,
    getActiveExplorer,

    // Pane operations (on active tab)
    setActivePane,
    switchPane,
    toggleDualPane,
    setDualPane,
    setSplitRatio,

    // Persistence
    save: saveState,
    captureState,
    restoreFromState,
  };
}

/** Factory for creating window tabs managers - exported for testing */
export { createWindowTabsManager };

export const windowTabsManager = createWindowTabsManager();
