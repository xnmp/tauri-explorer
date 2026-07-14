/**
 * Navigation commands: back, forward, up, home, refresh.
 */

import type { Command } from "../commands.svelte";
import { getActiveExplorer } from "./shared";
import { windowTabsManager } from "../window-tabs.svelte";

export const navigationCommands: Command[] = [
  {
    id: "navigation.goBack",
    label: "Go Back",
    category: "navigation",
    shortcut: "Ctrl+Alt+Left",
    handler: () => getActiveExplorer()?.goBack(),
    when: () => getActiveExplorer()?.canGoBack ?? false,
  },
  {
    id: "navigation.goForward",
    label: "Go Forward",
    category: "navigation",
    shortcut: "Ctrl+Alt+Right",
    handler: () => getActiveExplorer()?.goForward(),
    when: () => getActiveExplorer()?.canGoForward ?? false,
  },
  {
    id: "navigation.goUp",
    label: "Go Up",
    category: "navigation",
    shortcut: "Ctrl+Alt+Up",
    handler: () => getActiveExplorer()?.goUp(),
    when: () => (getActiveExplorer()?.breadcrumbs.length ?? 0) > 1,
  },
  {
    id: "navigation.goHome",
    label: "Go to Home",
    category: "navigation",
    handler: async () => {
      const { getHomeDirectory } = await import("$lib/api/files");
      const result = await getHomeDirectory();
      if (result.ok) {
        getActiveExplorer()?.navigateTo(result.data);
      }
    },
  },
  {
    id: "navigation.refresh",
    label: "Refresh",
    category: "navigation",
    shortcut: "F5",
    handler: () => getActiveExplorer()?.refresh(),
    // While the active pane shows the commit graph, F5 belongs to the graph's
    // own fetch+reload handler (#417) — refreshing the hidden file listing
    // here would double-handle the key with no visible effect.
    when: () => {
      const tab = windowTabsManager.activeTab;
      return !tab?.panes?.[tab.activePaneId]?.gitGraph;
    },
  },
];
