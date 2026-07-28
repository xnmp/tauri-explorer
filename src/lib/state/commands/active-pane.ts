import { windowTabsManager } from "../window-tabs.svelte";

/** True only when the currently active explorer pane is showing a graph. */
export function activePaneIsGraph(): boolean {
  const tab = windowTabsManager.activeTab;
  return !!(tab?.kind === "explorer" && tab.panes?.[tab.activePaneId]?.gitGraph);
}
