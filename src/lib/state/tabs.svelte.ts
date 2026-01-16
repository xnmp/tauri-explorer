/**
 * Tabs state management for multi-tab panes.
 * Issue: tauri-explorer-auj
 *
 * Manages tabs within each pane, including creation, closing,
 * and active tab tracking.
 */

import type { PaneId } from "./types";
import { createExplorerState, type ExplorerInstance } from "./explorer.svelte";

export interface Tab {
  id: string;
  title: string;
  path: string;
  explorer: ExplorerInstance;
}

interface PaneTabs {
  tabs: Tab[];
  activeTabId: string | null;
}

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTabsManager() {
  // Tabs for each pane
  let panes = $state<Record<PaneId, PaneTabs>>({
    left: { tabs: [], activeTabId: null },
    right: { tabs: [], activeTabId: null },
  });

  /** Initialize a pane with a default tab */
  function initPane(paneId: PaneId, initialPath: string): Tab {
    const explorer = createExplorerState();
    const tab: Tab = {
      id: generateTabId(),
      title: extractFolderName(initialPath),
      path: initialPath,
      explorer,
    };

    panes[paneId] = {
      tabs: [tab],
      activeTabId: tab.id,
    };

    // Navigate explorer to path
    explorer.navigateTo(initialPath);

    return tab;
  }

  /** Create a new tab in a pane */
  function createTab(paneId: PaneId, path?: string): Tab {
    const pane = panes[paneId];
    const explorer = createExplorerState();

    // Use provided path or copy from active tab
    const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
    const tabPath = path ?? activeTab?.path ?? "/home";

    const tab: Tab = {
      id: generateTabId(),
      title: extractFolderName(tabPath),
      path: tabPath,
      explorer,
    };

    // Navigate explorer to path
    explorer.navigateTo(tabPath);

    // Add tab after active tab
    const activeIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : pane.tabs.length;

    const newTabs = [...pane.tabs];
    newTabs.splice(insertIndex, 0, tab);

    panes[paneId] = {
      tabs: newTabs,
      activeTabId: tab.id,
    };

    return tab;
  }

  /** Close a tab by ID */
  function closeTab(paneId: PaneId, tabId: string): void {
    const pane = panes[paneId];
    if (pane.tabs.length <= 1) {
      // Don't close the last tab - could create a new empty tab or keep it
      return;
    }

    const tabIndex = pane.tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const newTabs = pane.tabs.filter((t) => t.id !== tabId);

    // Update active tab if closing the active one
    let newActiveId = pane.activeTabId;
    if (pane.activeTabId === tabId) {
      // Activate the tab to the left, or the first one if closing the first
      const newIndex = Math.max(0, tabIndex - 1);
      newActiveId = newTabs[newIndex]?.id ?? null;
    }

    panes[paneId] = {
      tabs: newTabs,
      activeTabId: newActiveId,
    };
  }

  /** Close the active tab in a pane */
  function closeActiveTab(paneId: PaneId): void {
    const pane = panes[paneId];
    if (pane.activeTabId) {
      closeTab(paneId, pane.activeTabId);
    }
  }

  /** Set the active tab */
  function setActiveTab(paneId: PaneId, tabId: string): void {
    const pane = panes[paneId];
    if (pane.tabs.some((t) => t.id === tabId)) {
      panes[paneId] = { ...pane, activeTabId: tabId };
    }
  }

  /** Get the active tab for a pane */
  function getActiveTab(paneId: PaneId): Tab | undefined {
    const pane = panes[paneId];
    return pane.tabs.find((t) => t.id === pane.activeTabId);
  }

  /** Get the active explorer for a pane */
  function getActiveExplorer(paneId: PaneId): ExplorerInstance | undefined {
    return getActiveTab(paneId)?.explorer;
  }

  /** Update tab title when path changes */
  function updateTabPath(paneId: PaneId, tabId: string, path: string): void {
    const pane = panes[paneId];
    const tabIndex = pane.tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const newTabs = [...pane.tabs];
    newTabs[tabIndex] = {
      ...newTabs[tabIndex],
      path,
      title: extractFolderName(path),
    };

    panes[paneId] = { ...pane, tabs: newTabs };
  }

  /** Move to next tab (wraps around) */
  function nextTab(paneId: PaneId): void {
    const pane = panes[paneId];
    if (pane.tabs.length <= 1) return;

    const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    const nextIndex = (currentIndex + 1) % pane.tabs.length;
    panes[paneId] = { ...pane, activeTabId: pane.tabs[nextIndex].id };
  }

  /** Move to previous tab (wraps around) */
  function prevTab(paneId: PaneId): void {
    const pane = panes[paneId];
    if (pane.tabs.length <= 1) return;

    const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    const prevIndex = (currentIndex - 1 + pane.tabs.length) % pane.tabs.length;
    panes[paneId] = { ...pane, activeTabId: pane.tabs[prevIndex].id };
  }

  /** Get all tabs for a pane */
  function getTabs(paneId: PaneId): Tab[] {
    return panes[paneId].tabs;
  }

  /** Reorder tabs */
  function reorderTabs(paneId: PaneId, fromIndex: number, toIndex: number): void {
    const pane = panes[paneId];
    if (fromIndex < 0 || fromIndex >= pane.tabs.length) return;
    if (toIndex < 0 || toIndex >= pane.tabs.length) return;
    if (fromIndex === toIndex) return;

    const newTabs = [...pane.tabs];
    const [moved] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, moved);

    panes[paneId] = { ...pane, tabs: newTabs };
  }

  return {
    get panes() {
      return panes;
    },
    initPane,
    createTab,
    closeTab,
    closeActiveTab,
    setActiveTab,
    getActiveTab,
    getActiveExplorer,
    updateTabPath,
    nextTab,
    prevTab,
    getTabs,
    reorderTabs,
  };
}

function extractFolderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export const tabsManager = createTabsManager();
