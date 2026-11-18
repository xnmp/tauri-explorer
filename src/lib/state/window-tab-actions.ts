/**
 * Tab strip actions behind a tab's context menu (#1749): Close, Close Others,
 * Close to the Right, Duplicate and Reopen Closed Tab, built on the window
 * tabs manager's existing close/export/adopt/restore operations.
 */
import { tabsToClose } from "$lib/domain/window-tab-order";
import type { WindowTab } from "./types";
import type { createWindowTabsManager } from "./window-tabs.svelte";

type Manager = ReturnType<typeof createWindowTabsManager>;

/** Close the tabs around `keepId`. The kept tab is activated first when the
 *  active one is among them, so no intermediate neighbour becomes active;
 *  every close stays restorable with Ctrl+Shift+T. */
function closeTabsAround(manager: Manager, keepId: string, scope: "others" | "right"): void {
  const doomed = tabsToClose(manager.tabs.map((t) => t.id), keepId, scope);
  if (manager.activeTabId && doomed.includes(manager.activeTabId)) manager.setActiveTab(keepId);
  for (const id of doomed) manager.closeTab(id);
}

/** Close every tab but `tabId`. */
export function closeOtherTabs(manager: Manager, tabId: string): void {
  closeTabsAround(manager, tabId, "others");
}

/** Close every tab after `tabId` in the strip. */
export function closeTabsToRight(manager: Manager, tabId: string): void {
  closeTabsAround(manager, tabId, "right");
}

/** Open a copy of a tab (its whole pane layout) right after it, active. */
export function duplicateTab(manager: Manager, tabId: string): WindowTab | null {
  const snapshot = manager.exportTab(tabId);
  if (!snapshot || !manager.acceptsTransfers) return null;
  return manager.adoptTab(snapshot, manager.tabs.findIndex((t) => t.id === tabId) + 1);
}

export interface TabMenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
  readonly run: () => void;
}

/** The context menu for `tabId`. `openWindow` restores a tab that was
 *  closed with its window, as the Reopen command does. */
export function tabMenuItems(manager: Manager, tabId: string, openWindow: (path: string) => unknown): TabMenuItem[] {
  const count = manager.tabs.length;
  const index = manager.tabs.findIndex((t) => t.id === tabId);
  return [
    { id: "close", label: "Close", run: () => manager.closeTab(tabId) },
    { id: "close-others", label: "Close Others", disabled: count <= 1, run: () => closeOtherTabs(manager, tabId) },
    { id: "close-right", label: "Close to the Right", disabled: index < 0 || index >= count - 1, run: () => closeTabsToRight(manager, tabId) },
    { id: "duplicate", label: "Duplicate", separatorBefore: true, run: () => void duplicateTab(manager, tabId) },
    {
      id: "reopen", label: "Reopen Closed Tab", separatorBefore: true, disabled: !manager.canRestoreTab,
      run: () => {
        const result = manager.restoreClosedTab();
        if (result && result.openInNewWindow) openWindow(result.openInNewWindow);
      },
    },
  ];
}
