/**
 * Navigation commands: back, forward, up, home, refresh.
 */

import { TRASH_PATH } from "$lib/domain/virtual-path";
import type { Command } from "../commands.svelte";
import { getActiveExplorer } from "./shared";
import { windowTabsManager } from "../window-tabs.svelte";
import { refreshGraphPane } from "../git-graph-refresh";
import { stepGraphSelection } from "../git-graph-nav";
import { activePaneIsGraph } from "./active-pane";
import { settingsStore } from "../settings.svelte";

export const navigationCommands: Command[] = [
  {
    id: "navigation.openRecycleBin",
    scope: "pane",
    label: "Open Recycle Bin",
    category: "navigation",
    handler: () => { void getActiveExplorer()?.navigateTo(TRASH_PATH); },
  },
  {
    id: "navigation.focusAddressBar",
    scope: "pane",
    label: "Focus Address Bar",
    category: "navigation",
    shortcut: "Ctrl+L",
    handler: () => {
      window.dispatchEvent(new Event("explorer:focus-address-bar"));
    },
    when: () => settingsStore.showAddressBar && !!getActiveExplorer(),
  },
  {
    id: "navigation.goBack",
    scope: "pane",
    label: "Go Back",
    category: "navigation",
    shortcut: "Ctrl+Alt+Left",
    handler: () => getActiveExplorer()?.goBack(),
    when: () => getActiveExplorer()?.canGoBack ?? false,
  },
  {
    id: "navigation.goForward",
    scope: "pane",
    label: "Go Forward",
    category: "navigation",
    shortcut: "Ctrl+Alt+Right",
    handler: () => getActiveExplorer()?.goForward(),
    when: () => getActiveExplorer()?.canGoForward ?? false,
  },
  {
    id: "navigation.goUp",
    scope: "pane",
    label: "Go Up",
    category: "navigation",
    shortcut: "Ctrl+Alt+Up",
    handler: () => getActiveExplorer()?.goUp(),
    when: () => (getActiveExplorer()?.breadcrumbs.length ?? 0) > 1,
  },
  {
    id: "navigation.goHome",
    scope: "pane",
    label: "Go to Home",
    category: "navigation",
    handler: async () => {
      const { getHomeDirectory } = await import("$lib/api/environment");
      const result = await getHomeDirectory();
      if (result.ok) {
        getActiveExplorer()?.navigateTo(result.data);
      }
    },
  },
  {
    id: "navigation.refresh",
    scope: "pane",
    label: "Refresh",
    category: "navigation",
    shortcut: "F5",
    handler: () => getActiveExplorer()?.refresh({ explicit: true }),
    // While the active pane shows the commit graph, F5 belongs to
    // `gitGraph.refresh` below — refreshing the hidden file listing here would
    // double-handle the key with no visible effect (#417, #432).
    when: () => !activePaneIsGraph(),
  },
  {
    id: "gitGraph.refresh",
    scope: "pane",
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
  // Jump the selection along the branch line the commit sits on, skipping the
  // rows drawn in between that belong to other lines (#530). Down = older
  // (toward parents), up = newer, matching the graph's newest-first order.
  // Real commands, like F5 above: rebindable, palette-discoverable, gated on
  // the active graph pane, and visible to the terminal key-ownership gate.
  {
    id: "gitGraph.selectOlderOnLine",
    scope: "pane",
    label: "Git Graph: Select Older Commit on Branch Line",
    category: "navigation",
    shortcut: "Ctrl+Down",
    handler: () => {
      stepGraphSelection(windowTabsManager.activeTab?.activePaneId, "older");
    },
    when: () => activePaneIsGraph(),
  },
  {
    id: "gitGraph.selectNewerOnLine",
    scope: "pane",
    label: "Git Graph: Select Newer Commit on Branch Line",
    category: "navigation",
    shortcut: "Ctrl+Up",
    handler: () => {
      stepGraphSelection(windowTabsManager.activeTab?.activePaneId, "newer");
    },
    when: () => activePaneIsGraph(),
  },
];
