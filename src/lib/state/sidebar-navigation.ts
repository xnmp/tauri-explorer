import { windowTabsManager } from "./window-tabs.svelte";
import { dialogStore } from "./dialogs.svelte";

/** Sidebar mouse and keyboard actions share the active-pane navigation seam. */
export function navigateFromSidebar(path: string): void {
  if (dialogStore.isPaneBlocked(windowTabsManager.activePaneId)) return;
  windowTabsManager.getActiveExplorer()?.navigateTo(path);
}
