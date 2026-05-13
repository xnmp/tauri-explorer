/**
 * Pane commands: dual pane, focus switching, copy-to-other-pane.
 */

import type { Command } from "../commands.svelte";
import { windowTabsManager } from "../window-tabs.svelte";
import { fetchDirectory } from "$lib/api/files";
import { pasteEntries, type PasteSource } from "../paste-operations";
import { getActiveExplorer } from "./shared";

/** Dual-pane toggle and focus commands */
export const paneCommands: Command[] = [
  {
    id: "view.toggleDualPane",
    label: "Toggle Dual Pane",
    category: "view",
    shortcut: "Ctrl+Shift+D",
    handler: () => windowTabsManager.toggleDualPane(),
  },
  {
    id: "view.switchPane",
    label: "Switch Pane",
    category: "view",
    shortcut: "Alt+Right",
    handler: () => windowTabsManager.switchPane(),
    when: () => windowTabsManager.dualPaneEnabled,
  },
];

/** Cross-pane file operation commands */
export const crossPaneCommands: Command[] = [
  {
    id: "pane.copyToOther",
    label: "Copy to Other Pane",
    category: "file",
    shortcut: "Ctrl+Shift+F5",
    handler: async () => {
      if (!windowTabsManager.dualPaneEnabled) return;
      const activePaneId = windowTabsManager.activePaneId;
      const otherPaneId = activePaneId === "left" ? "right" : "left";
      const activeExplorer = windowTabsManager.getExplorer(activePaneId);
      const otherExplorer = windowTabsManager.getExplorer(otherPaneId);
      if (!activeExplorer || !otherExplorer) return;

      const selected = activeExplorer.getSelectedEntries();
      if (selected.length === 0) return;

      const destPath = otherExplorer.state.currentPath;
      const dirResult = await fetchDirectory(destPath);
      const existingEntries = dirResult.ok ? [...dirResult.data.entries] : [];
      const sources: PasteSource[] = selected.map((e) => ({ path: e.path, name: e.name, size: e.size, modified: e.modified }));

      await pasteEntries(sources, false, {
        destPath,
        existingEntries,
        onEntriesAdded: () => {},
        onRefresh: () => Promise.all([otherExplorer.refresh({ silent: true })]),
      });
    },
    when: () => windowTabsManager.dualPaneEnabled,
  },
  {
    id: "pane.moveToOther",
    label: "Move to Other Pane",
    category: "file",
    shortcut: "F6",
    handler: async () => {
      if (!windowTabsManager.dualPaneEnabled) return;
      const activePaneId = windowTabsManager.activePaneId;
      const otherPaneId = activePaneId === "left" ? "right" : "left";
      const activeExplorer = windowTabsManager.getExplorer(activePaneId);
      const otherExplorer = windowTabsManager.getExplorer(otherPaneId);
      if (!activeExplorer || !otherExplorer) return;

      const selected = activeExplorer.getSelectedEntries();
      if (selected.length === 0) return;

      const destPath = otherExplorer.state.currentPath;
      const dirResult = await fetchDirectory(destPath);
      const existingEntries = dirResult.ok ? [...dirResult.data.entries] : [];
      const sources: PasteSource[] = selected.map((e) => ({ path: e.path, name: e.name, size: e.size, modified: e.modified }));

      await pasteEntries(sources, true, {
        destPath,
        existingEntries,
        onEntriesAdded: () => {},
        onRefresh: () => Promise.all([activeExplorer.refresh({ silent: true }), otherExplorer.refresh({ silent: true })]),
      });
    },
    when: () => windowTabsManager.dualPaneEnabled,
  },
];
