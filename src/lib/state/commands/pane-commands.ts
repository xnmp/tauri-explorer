/**
 * Pane commands: splits (#228), dual pane, focus switching, copy-to-other-pane.
 */

import type { Command } from "../commands.svelte";
import { windowTabsManager } from "../window-tabs.svelte";
import { fetchDirectory } from "$lib/api/files";
import { pasteEntries, type PasteSource } from "../paste-operations";
import type { ExplorerInstance } from "../explorer.svelte";

/** The explorer of the pane after the active one in visual order. */
function getNextPaneExplorer(): ExplorerInstance | undefined {
  const ids = windowTabsManager.activePaneIds;
  if (ids.length <= 1) return undefined;
  const idx = ids.indexOf(windowTabsManager.activePaneId);
  return windowTabsManager.getExplorer(ids[(idx + 1) % ids.length]);
}

const activeTabIsExplorer = () => windowTabsManager.activeTab?.kind === "explorer";

/** Pane layout and focus commands */
export const paneCommands: Command[] = [
  {
    id: "view.toggleDualPane",
    label: "Toggle Dual Pane",
    category: "view",
    shortcut: "Ctrl+Shift+D",
    handler: () => windowTabsManager.toggleDualPane(),
    when: activeTabIsExplorer,
  },
  {
    id: "view.switchPane",
    label: "Focus Next Pane",
    category: "view",
    shortcut: "Alt+Right",
    handler: () => windowTabsManager.switchPane(),
    when: () => windowTabsManager.dualPaneEnabled,
  },
  {
    id: "pane.new",
    label: "New Pane",
    category: "view",
    shortcut: "Ctrl+M",
    handler: () => windowTabsManager.newPane(),
    when: activeTabIsExplorer,
  },
  // Directional splits on a right-hand home-row cluster (#229):
  // L=left, ;=down, '=right, P=up. Default modifier is Cmd/Super+Alt (#239);
  // rebindable in Settings → Keybindings like every other shortcut.
  {
    id: "pane.splitLeft",
    label: "Split Pane Left",
    category: "view",
    shortcut: "Cmd+Alt+L",
    handler: () => windowTabsManager.splitPane("left"),
    when: activeTabIsExplorer,
  },
  {
    id: "pane.splitRight",
    label: "Split Pane Right",
    category: "view",
    shortcut: "Cmd+Alt+'",
    handler: () => windowTabsManager.splitPane("right"),
    when: activeTabIsExplorer,
  },
  {
    id: "pane.splitUp",
    label: "Split Pane Up",
    category: "view",
    shortcut: "Cmd+Alt+P",
    handler: () => windowTabsManager.splitPane("up"),
    when: activeTabIsExplorer,
  },
  {
    id: "pane.splitDown",
    label: "Split Pane Down",
    category: "view",
    shortcut: "Cmd+Alt+;",
    handler: () => windowTabsManager.splitPane("down"),
    when: activeTabIsExplorer,
  },
  {
    // Palette-only: Ctrl+W (Close Surface) covers the common case; this
    // stays for explicitly closing the focused pane.
    id: "pane.close",
    label: "Close Pane",
    category: "view",
    handler: () => windowTabsManager.closePane(),
    when: () => windowTabsManager.dualPaneEnabled,
  },
];

/** Copy/move the selection into the next pane's directory. */
async function transferToNextPane(move: boolean): Promise<void> {
  if (!windowTabsManager.dualPaneEnabled) return;
  const activeExplorer = windowTabsManager.getActiveExplorer();
  const otherExplorer = getNextPaneExplorer();
  if (!activeExplorer || !otherExplorer) return;

  const selected = activeExplorer.getSelectedEntries();
  if (selected.length === 0) return;

  const destPath = otherExplorer.state.currentPath;
  const dirResult = await fetchDirectory(destPath);
  const existingEntries = dirResult.ok ? [...dirResult.data.entries] : [];
  const sources: PasteSource[] = selected.map((e) => ({
    path: e.path,
    name: e.name,
    size: e.size,
    modified: e.modified,
  }));

  const refreshTargets = move ? [activeExplorer, otherExplorer] : [otherExplorer];
  await pasteEntries(sources, move, {
    destPath,
    existingEntries,
    onEntriesAdded: () => {},
    onRefresh: () => Promise.all(refreshTargets.map((ex) => ex.refresh({ silent: true }))),
  });
}

/** Cross-pane file operation commands */
export const crossPaneCommands: Command[] = [
  {
    id: "pane.copyToOther",
    label: "Copy to Other Pane",
    category: "file",
    shortcut: "Ctrl+Shift+F5",
    handler: () => transferToNextPane(false),
    when: () => windowTabsManager.dualPaneEnabled,
  },
  {
    id: "pane.moveToOther",
    label: "Move to Other Pane",
    category: "file",
    shortcut: "F6",
    handler: () => transferToNextPane(true),
    when: () => windowTabsManager.dualPaneEnabled,
  },
];
