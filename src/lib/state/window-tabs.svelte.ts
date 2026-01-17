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

const STORAGE_KEY = "explorer-tabs";

/** Serializable tab state for persistence */
interface PersistedPane {
  path: string;
}

interface PersistedTab {
  id: string;
  panes: {
    left: PersistedPane;
    right: PersistedPane;
  };
  activePaneId: PaneId;
  dualPaneEnabled: boolean;
  splitRatio: number;
}

interface PersistedTabState {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

/** Generate unique IDs for tabs and explorers */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Extract folder name from path for tab title */
function extractFolderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path || "Explorer";
}

function createWindowTabsManager() {
  // Explorer instances registry (keyed by explorerId)
  const explorers = new Map<string, ExplorerInstance>();

  // Window tabs state
  let tabs = $state<WindowTab[]>([]);
  let activeTabId = $state<string | null>(null);

  /** Save current tab state to localStorage */
  function saveState(): void {
    if (typeof localStorage === "undefined") return;

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

    const state: PersistedTabState = {
      tabs: persistedTabs,
      activeTabId,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /** Load tab state from localStorage */
  function loadState(): PersistedTabState | null {
    if (typeof localStorage === "undefined") return null;

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return null;
      return JSON.parse(saved) as PersistedTabState;
    } catch {
      return null;
    }
  }

  /** Get the currently active tab */
  const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? null);

  /** Get tab title (shows active pane's folder name) - derived from explorer's current path */
  function getTabTitle(tab: WindowTab): string {
    const pane = tab.panes[tab.activePaneId];
    const explorer = explorers.get(pane.explorerId);
    if (!explorer) return pane.title || "Explorer";
    return extractFolderName(explorer.state.currentPath);
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

  /** Restore tabs from a persisted state */
  function restoreFromState(state: PersistedTabState): void {
    explorers.clear();

    const restoredTabs: WindowTab[] = state.tabs.map((persistedTab) => {
      const tab: WindowTab = {
        id: persistedTab.id,
        panes: {
          left: createPane(persistedTab.panes.left.path),
          right: createPane(persistedTab.panes.right.path),
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

  /** Initialize - restores from localStorage or creates a new tab */
  function init(initialPath: string): WindowTab {
    // Try to restore from localStorage
    const savedState = loadState();
    if (savedState && savedState.tabs.length > 0) {
      restoreFromState(savedState);
      const restored = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
      if (restored && !activeTabId) {
        activeTabId = restored.id;
      }
      return restored;
    }

    // No saved state, create new
    explorers.clear();
    tabs = [];
    activeTabId = null;
    return createTab(initialPath);
  }

  /** Close a tab by ID */
  function closeTab(tabId: string): void {
    if (tabs.length <= 1) {
      // Don't close the last tab
      return;
    }

    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];

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
  };
}

export const windowTabsManager = createWindowTabsManager();
