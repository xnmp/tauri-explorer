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

  /** Get the currently active tab */
  const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? null);

  /** Get tab title (shows active pane's folder name) */
  function getTabTitle(tab: WindowTab): string {
    const pane = tab.panes[tab.activePaneId];
    return pane.title || "Explorer";
  }

  /** Get tooltip for tab (shows both pane paths when dual-pane) */
  function getTabTooltip(tab: WindowTab): string {
    if (!tab.dualPaneEnabled) {
      return tab.panes[tab.activePaneId].path;
    }
    return `Left: ${tab.panes.left.path}\nRight: ${tab.panes.right.path}`;
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
    const defaultPath = initialPath ?? "/home";

    // Get path from current active tab if available
    const currentTab = tabs.find((t) => t.id === activeTabId);
    const leftPath = initialPath ?? currentTab?.panes.left.path ?? defaultPath;
    const rightPath = currentTab?.panes.right.path ?? defaultPath;

    const tab: WindowTab = {
      id: generateId("tab"),
      panes: {
        left: createPane(leftPath),
        right: createPane(rightPath),
      },
      activePaneId: "left",
      dualPaneEnabled: currentTab?.dualPaneEnabled ?? false,
      splitRatio: currentTab?.splitRatio ?? 0.5,
    };

    // Insert after active tab or at end
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : tabs.length;

    const newTabs = [...tabs];
    newTabs.splice(insertIndex, 0, tab);
    tabs = newTabs;
    activeTabId = tab.id;

    return tab;
  }

  /** Initialize with a single tab */
  function init(initialPath: string): WindowTab {
    // Clean up any existing explorers
    for (const explorer of explorers.values()) {
      // Explorers don't have cleanup, but we clear the registry
    }
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
    }
  }

  /** Move to next tab (wraps around) */
  function nextTab(): void {
    if (tabs.length <= 1) return;

    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    const nextIndex = (currentIndex + 1) % tabs.length;
    activeTabId = tabs[nextIndex].id;
  }

  /** Move to previous tab (wraps around) */
  function prevTab(): void {
    if (tabs.length <= 1) return;

    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    activeTabId = tabs[prevIndex].id;
  }

  /** Get explorer instance for a pane in the active tab */
  function getExplorer(paneId: PaneId): ExplorerInstance | undefined {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return undefined;
    const explorerId = tab.panes[paneId].explorerId;
    return explorers.get(explorerId);
  }

  /** Get the active explorer (from active pane in active tab) */
  function getActiveExplorer(): ExplorerInstance | undefined {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return undefined;
    return getExplorer(tab.activePaneId);
  }

  /** Set the active pane in the active tab */
  function setActivePane(paneId: PaneId): void {
    const tabIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];
    if (tab.activePaneId === paneId) return;

    tabs = tabs.map((t) =>
      t.id === activeTabId ? { ...t, activePaneId: paneId } : t
    );
  }

  /** Switch to the other pane in the active tab */
  function switchPane(): void {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.dualPaneEnabled) return;

    setActivePane(tab.activePaneId === "left" ? "right" : "left");
  }

  /** Toggle dual pane mode in the active tab */
  function toggleDualPane(): void {
    const tabIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];
    const newDualPaneEnabled = !tab.dualPaneEnabled;

    tabs = tabs.map((t) =>
      t.id === activeTabId
        ? {
            ...t,
            dualPaneEnabled: newDualPaneEnabled,
            // Reset to left pane when disabling dual pane
            activePaneId: newDualPaneEnabled ? t.activePaneId : "left",
          }
        : t
    );
  }

  /** Enable dual pane mode in the active tab */
  function enableDualPane(): void {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.dualPaneEnabled) return;
    toggleDualPane();
  }

  /** Disable dual pane mode in the active tab */
  function disableDualPane(): void {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.dualPaneEnabled) return;
    toggleDualPane();
  }

  /** Set split ratio in the active tab */
  function setSplitRatio(ratio: number): void {
    const tabIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (tabIndex === -1) return;

    const clampedRatio = Math.max(0.2, Math.min(0.8, ratio));

    tabs = tabs.map((t) =>
      t.id === activeTabId ? { ...t, splitRatio: clampedRatio } : t
    );
  }

  /** Update pane path and title when navigation happens */
  function updatePanePath(paneId: PaneId, path: string): void {
    const tabIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (tabIndex === -1) return;

    const title = extractFolderName(path);

    tabs = tabs.map((t) => {
      if (t.id !== activeTabId) return t;
      return {
        ...t,
        panes: {
          ...t.panes,
          [paneId]: {
            ...t.panes[paneId],
            path,
            title,
          },
        },
      };
    });
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
    enableDualPane,
    disableDualPane,
    setSplitRatio,
    updatePanePath,
  };
}

export const windowTabsManager = createWindowTabsManager();
