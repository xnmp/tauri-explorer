/**
 * Navigation commands: back, forward, up, home, refresh.
 */

import type { Command } from "../commands.svelte";
import { getActiveExplorer } from "./shared";
import { windowTabsManager } from "../window-tabs.svelte";
import { refreshGraphPane } from "../git-graph-refresh";

/** True when the active pane is showing a commit graph. */
function activePaneIsGraph(): boolean {
  const tab = windowTabsManager.activeTab;
  return !!(tab?.kind === "explorer" && tab.panes?.[tab.activePaneId]?.gitGraph);
}

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
    // While the active pane shows the commit graph, F5 belongs to
    // `gitGraph.refresh` below — refreshing the hidden file listing here would
    // double-handle the key with no visible effect (#417, #432).
    when: () => !activePaneIsGraph(),
  },
  {
    id: "gitGraph.refresh",
    label: "Git Graph: Refresh (fetch from remotes)",
    category: "navigation",
    shortcut: "F5",
    // F5 in the graph fetches from every remote then reloads history (#417).
    // A real command (not a component window listener) so the terminal's
    // key-ownership gate can see the graph owns F5, and so it only fires for
    // the ACTIVE graph pane (#432).
    handler: () => {
      refreshGraphPane(windowTabsManager.activeTab?.activePaneId);
    },
    when: () => activePaneIsGraph(),
  },
];
