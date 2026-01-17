/**
 * Command definitions for the command palette.
 * Issue: tauri-explorer-abm
 *
 * Registers all available app commands. Commands are grouped by category
 * and include keyboard shortcuts where applicable.
 */

import { registerCommands, type Command } from "./commands.svelte";
import { windowTabsManager } from "./window-tabs.svelte";
import { settingsStore } from "./settings.svelte";
import { themeStore } from "./theme.svelte";
import { bookmarksStore } from "./bookmarks.svelte";
import type { ViewMode } from "./types";

/** Get the active explorer instance for commands */
function getActiveExplorer() {
  return windowTabsManager.getActiveExplorer();
}

/** Navigation commands */
const navigationCommands: Command[] = [
  {
    id: "navigation.goBack",
    label: "Go Back",
    category: "navigation",
    shortcut: "Alt+Left",
    handler: () => getActiveExplorer()?.goBack(),
    when: () => getActiveExplorer()?.canGoBack ?? false,
  },
  {
    id: "navigation.goForward",
    label: "Go Forward",
    category: "navigation",
    shortcut: "Alt+Right",
    handler: () => getActiveExplorer()?.goForward(),
    when: () => getActiveExplorer()?.canGoForward ?? false,
  },
  {
    id: "navigation.goUp",
    label: "Go Up",
    category: "navigation",
    shortcut: "Alt+Up",
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
  },
];

/** File operation commands */
const fileCommands: Command[] = [
  {
    id: "file.newFolder",
    label: "New Folder",
    category: "file",
    shortcut: "Ctrl+Shift+N",
    handler: () => getActiveExplorer()?.openNewFolderDialog(),
  },
  {
    id: "file.rename",
    label: "Rename",
    category: "file",
    shortcut: "F2",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      if (selected) {
        explorer?.startRename(selected);
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "file.delete",
    label: "Delete",
    category: "file",
    shortcut: "Delete",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      if (selected) {
        explorer?.startDelete(selected);
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "file.openSelected",
    label: "Open",
    category: "file",
    shortcut: "Enter",
    handler: async () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      if (selected) {
        if (selected.kind === "directory") {
          explorer?.navigateTo(selected.path);
        } else {
          const { openFile } = await import("$lib/api/files");
          await openFile(selected.path);
        }
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
];

/** Edit commands (clipboard operations) */
const editCommands: Command[] = [
  {
    id: "edit.copy",
    label: "Copy",
    category: "edit",
    shortcut: "Ctrl+C",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      if (selected) explorer?.copyToClipboard(selected);
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "edit.cut",
    label: "Cut",
    category: "edit",
    shortcut: "Ctrl+X",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      if (selected) explorer?.cutToClipboard(selected);
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "edit.paste",
    label: "Paste",
    category: "edit",
    shortcut: "Ctrl+V",
    handler: async () => {
      await getActiveExplorer()?.paste();
    },
  },
  {
    id: "edit.undo",
    label: "Undo",
    category: "edit",
    shortcut: "Ctrl+Z",
    handler: async () => {
      await getActiveExplorer()?.undo();
    },
  },
];

/** Selection commands */
const selectionCommands: Command[] = [
  {
    id: "selection.selectAll",
    label: "Select All",
    category: "selection",
    shortcut: "Ctrl+A",
    handler: () => getActiveExplorer()?.selectAll(),
  },
  {
    id: "selection.clearSelection",
    label: "Clear Selection",
    category: "selection",
    shortcut: "Escape",
    handler: () => getActiveExplorer()?.clearSelection(),
    when: () => (getActiveExplorer()?.state.selectedPaths.size ?? 0) > 0,
  },
];

/** View commands */
const viewCommands: Command[] = [
  {
    id: "view.details",
    label: "Details View",
    category: "view",
    handler: () => getActiveExplorer()?.setViewMode("details"),
  },
  {
    id: "view.list",
    label: "List View",
    category: "view",
    handler: () => getActiveExplorer()?.setViewMode("list"),
  },
  {
    id: "view.tiles",
    label: "Tiles View",
    category: "view",
    handler: () => getActiveExplorer()?.setViewMode("tiles"),
  },
  {
    id: "view.toggleSidebar",
    label: "Toggle Sidebar",
    category: "view",
    handler: () => settingsStore.toggleSidebar(),
  },
  {
    id: "view.toggleToolbar",
    label: "Toggle Toolbar",
    category: "view",
    handler: () => settingsStore.toggleToolbar(),
  },
  {
    id: "view.toggleDualPane",
    label: "Toggle Dual Pane",
    category: "view",
    shortcut: "F6",
    handler: () => windowTabsManager.toggleDualPane(),
  },
  {
    id: "view.switchPane",
    label: "Switch Pane",
    category: "view",
    shortcut: "Ctrl+Tab",
    handler: () => windowTabsManager.switchPane(),
    when: () => windowTabsManager.dualPaneEnabled,
  },
  {
    id: "view.toggleTheme",
    label: "Toggle Dark/Light Theme",
    category: "view",
    handler: () => {
      const current = themeStore.currentThemeId;
      themeStore.setTheme(current === "dark" ? "light" : "dark");
    },
  },
  {
    id: "view.toggleHidden",
    label: "Toggle Hidden Files",
    category: "view",
    shortcut: "Ctrl+H",
    handler: () => getActiveExplorer()?.toggleHidden(),
  },
];

/** Bookmark commands */
const bookmarkCommands: Command[] = [
  {
    id: "bookmarks.addCurrent",
    label: "Bookmark Current Folder",
    category: "bookmarks",
    handler: () => {
      const explorer = getActiveExplorer();
      if (explorer) {
        bookmarksStore.addBookmark(explorer.state.currentPath);
      }
    },
    when: () => {
      const explorer = getActiveExplorer();
      return explorer ? !bookmarksStore.hasBookmark(explorer.state.currentPath) : false;
    },
  },
  {
    id: "bookmarks.removeCurrent",
    label: "Remove Current Bookmark",
    category: "bookmarks",
    handler: () => {
      const explorer = getActiveExplorer();
      if (explorer) {
        bookmarksStore.removeBookmark(explorer.state.currentPath);
      }
    },
    when: () => {
      const explorer = getActiveExplorer();
      return explorer ? bookmarksStore.hasBookmark(explorer.state.currentPath) : false;
    },
  },
];

/** Tab commands */
const tabCommands: Command[] = [
  {
    id: "tabs.newTab",
    label: "New Tab",
    category: "general",
    shortcut: "Ctrl+T",
    handler: () => {
      windowTabsManager.createTab();
    },
  },
  {
    id: "tabs.closeTab",
    label: "Close Tab",
    category: "general",
    shortcut: "Ctrl+W",
    handler: () => windowTabsManager.closeActiveTab(),
    when: () => windowTabsManager.tabs.length > 1,
  },
  {
    id: "tabs.nextTab",
    label: "Next Tab",
    category: "general",
    shortcut: "Ctrl+Tab",
    handler: () => windowTabsManager.nextTab(),
    when: () => windowTabsManager.tabs.length > 1,
  },
  {
    id: "tabs.prevTab",
    label: "Previous Tab",
    category: "general",
    shortcut: "Ctrl+Shift+Tab",
    handler: () => windowTabsManager.prevTab(),
    when: () => windowTabsManager.tabs.length > 1,
  },
];

/** General commands */
const generalCommands: Command[] = [
  {
    id: "general.openQuickOpen",
    label: "Quick Open",
    category: "general",
    shortcut: "Ctrl+P",
    handler: () => {
      // This will be handled by the QuickOpen component
      window.dispatchEvent(new CustomEvent("open-quick-open"));
    },
  },
  {
    id: "general.openCommandPalette",
    label: "Command Palette",
    category: "general",
    shortcut: "Ctrl+Shift+P",
    handler: () => {
      window.dispatchEvent(new CustomEvent("open-command-palette"));
    },
  },
];

/** Register all commands */
export function registerAllCommands(): void {
  registerCommands([
    ...navigationCommands,
    ...fileCommands,
    ...editCommands,
    ...selectionCommands,
    ...viewCommands,
    ...bookmarkCommands,
    ...tabCommands,
    ...generalCommands,
  ]);
}
