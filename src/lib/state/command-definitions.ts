/**
 * Command definitions for the command palette.
 * Issue: tauri-explorer-abm, tauri-explorer-npjh.4
 *
 * Registers all available app commands. Commands are grouped by category
 * and include keyboard shortcuts where applicable.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { registerCommands, type Command } from "./commands.svelte";
import { keybindingsStore } from "./keybindings.svelte";
import { windowTabsManager } from "./window-tabs.svelte";
import { settingsStore } from "./settings.svelte";
import { themeStore } from "./theme.svelte";
import { bookmarksStore } from "./bookmarks.svelte";
import { recentFilesStore } from "./recent-files.svelte";
import { dialogStore } from "./dialogs.svelte";
import { copyEntry, moveEntry, writeTextFile, openInTerminal, clipboardPasteImage } from "$lib/api/files";
import type { ViewMode } from "./types";
import { readFocusedWindowState } from "./focused-window";

/** Open a new explorer window at the given path with optional view mode */
function openNewWindow(path: string, viewMode?: ViewMode): void {
  const label = "explorer-" + Date.now();
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({ path });
  if (viewMode) params.set("viewMode", viewMode);
  const url = `${baseUrl}?${params.toString()}`;
  new WebviewWindow(label, {
    url,
    width: 1200,
    height: 800,
    decorations: false,
    transparent: true,
    shadow: false,
    dragDropEnabled: false,
  });
}

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
  },
];

/** File operation commands */
const fileCommands: Command[] = [
  {
    id: "file.newFolder",
    label: "New Folder",
    category: "file",
    shortcut: "Ctrl+Shift+N",
    handler: () => getActiveExplorer()?.startInlineNewFolder(),
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
    id: "file.bulkRename",
    label: "Bulk Rename...",
    category: "file",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries() ?? [];
      if (selected.length >= 2) {
        dialogStore.openBulkRename(selected);
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) >= 2,
  },
  {
    id: "file.delete",
    label: "Delete",
    category: "file",
    shortcut: "Delete",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries();
      if (selected && selected.length > 0) {
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
      const selected = explorer?.getSelectedEntries() ?? [];
      if (selected.length > 0) explorer?.copyToClipboard(selected);
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
      const selected = explorer?.getSelectedEntries() ?? [];
      if (selected.length > 0) explorer?.cutToClipboard(selected);
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
  {
    id: "edit.redo",
    label: "Redo",
    category: "edit",
    shortcut: "Ctrl+Y",
    handler: async () => {
      await getActiveExplorer()?.redo();
    },
  },
  {
    id: "edit.redo2",
    label: "Redo (Alt)",
    category: "edit",
    shortcut: "Ctrl+Shift+Z",
    handler: async () => {
      await getActiveExplorer()?.redo();
    },
  },
  {
    id: "edit.pasteAsTextFile",
    label: "Paste Clipboard as Text File",
    category: "edit",
    handler: async () => {
      const explorer = getActiveExplorer();
      if (!explorer) return;
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const dir = explorer.currentPath;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const path = `${dir}/pasted-${timestamp}.txt`;
        await writeTextFile(path, text);
        explorer.refresh();
      } catch {
        // Clipboard access denied or empty
      }
    },
  },
  {
    id: "edit.pasteImage",
    label: "Paste Image from Clipboard",
    category: "edit",
    shortcut: "Ctrl+Shift+V",
    handler: async () => {
      const explorer = getActiveExplorer();
      if (!explorer) return;
      const result = await clipboardPasteImage(explorer.currentPath);
      if (result.ok) {
        explorer.refresh();
      }
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
    shortcut: "Alt+M E",
    handler: () => settingsStore.toggleSidebar(),
  },
  {
    id: "view.toggleToolbar",
    label: "Toggle Toolbar",
    category: "view",
    shortcut: "Alt+M B",
    handler: () => settingsStore.toggleToolbar(),
  },
  {
    id: "view.toggleWindowControls",
    label: "Toggle Window Controls",
    category: "view",
    handler: () => settingsStore.toggleWindowControls(),
  },
  {
    id: "view.togglePreviewPane",
    label: "Toggle Preview Pane",
    category: "view",
    shortcut: "Alt+P",
    handler: () => settingsStore.togglePreviewPane(),
  },
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
  {
    id: "view.zoomIn",
    label: "Zoom In",
    category: "view",
    shortcut: "Ctrl+=",
    handler: () => settingsStore.zoomIn(),
  },
  {
    id: "view.zoomOut",
    label: "Zoom Out",
    category: "view",
    shortcut: "Ctrl+-",
    handler: () => settingsStore.zoomOut(),
  },
  {
    id: "view.zoomReset",
    label: "Reset Zoom",
    category: "view",
    shortcut: "Ctrl+0",
    handler: () => settingsStore.zoomReset(),
  },
  {
    id: "view.toggleStatusBar",
    label: "Toggle Status Bar",
    category: "view",
    shortcut: "Alt+M U",
    handler: () => settingsStore.toggleStatusBar(),
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
        bookmarksStore.addBookmark(explorer.currentPath);
      }
    },
    when: () => {
      const explorer = getActiveExplorer();
      return explorer ? !bookmarksStore.hasBookmark(explorer.currentPath) : false;
    },
  },
  {
    id: "bookmarks.removeCurrent",
    label: "Remove Current Bookmark",
    category: "bookmarks",
    handler: () => {
      const explorer = getActiveExplorer();
      if (explorer) {
        bookmarksStore.removeBookmark(explorer.currentPath);
      }
    },
    when: () => {
      const explorer = getActiveExplorer();
      return explorer ? bookmarksStore.hasBookmark(explorer.currentPath) : false;
    },
  },
];

/** Cross-pane file operation commands */
const crossPaneCommands: Command[] = [
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

      const destDir = otherExplorer.state.currentPath;
      for (const entry of selected) {
        await copyEntry(entry.path, destDir);
      }
      otherExplorer.refresh();
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

      const destDir = otherExplorer.state.currentPath;
      for (const entry of selected) {
        await moveEntry(entry.path, destDir);
      }
      activeExplorer.refresh();
      otherExplorer.refresh();
    },
    when: () => windowTabsManager.dualPaneEnabled,
  },
];

/** Window commands */
const windowCommands: Command[] = [
  {
    id: "window.newWindow",
    label: "New Window",
    category: "general",
    shortcut: "Ctrl+N",
    handler: () => {
      // The window receiving Ctrl+N IS the focused window, so prefer
      // its active explorer. Fall back to localStorage for edge cases
      // (e.g. no active explorer yet).
      const explorer = getActiveExplorer();
      const focused = readFocusedWindowState();
      const path = explorer?.state.currentPath ?? focused?.path ?? "/home";
      const viewMode = explorer?.viewMode ?? focused?.viewMode;
      openNewWindow(path, viewMode);
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
    handler: () => void windowTabsManager.createTab(),
  },
  {
    id: "tabs.closeTab",
    label: "Close Tab",
    category: "general",
    shortcut: "Ctrl+W",
    handler: () => windowTabsManager.closeActiveTab(),
  },
  {
    id: "tabs.restoreClosedTab",
    label: "Restore Closed Tab",
    category: "general",
    shortcut: "Ctrl+Shift+T",
    handler: () => {
      const result = windowTabsManager.restoreClosedTab();
      if (result && result.openInNewWindow) {
        openNewWindow(result.openInNewWindow);
      }
    },
    when: () => windowTabsManager.canRestoreTab,
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

/** Recent files commands */
const recentCommands: Command[] = [
  {
    id: "recent.openRecent",
    label: "Open Recent...",
    category: "general",
    handler: () => {
      dialogStore.openQuickOpen();
    },
  },
  {
    id: "recent.clearHistory",
    label: "Clear Recent Files",
    category: "general",
    handler: () => recentFilesStore.clear(),
    when: () => recentFilesStore.count > 0,
  },
];

/** Workspace commands */
const workspaceCommands: Command[] = [
  {
    id: "workspace.open",
    label: "Workspaces: Manage...",
    category: "general",
    handler: () => {
      dialogStore.openWorkspace();
    },
  },
  {
    id: "workspace.saveQuick",
    label: "Workspaces: Save Current Layout",
    category: "general",
    handler: () => {
      dialogStore.openWorkspace();
    },
  },
];

/** Terminal command */
const terminalCommands: Command[] = [
  {
    id: "general.openTerminal",
    label: "Open Terminal Here",
    category: "general",
    shortcut: "Alt+M T",
    handler: () => {
      const explorer = getActiveExplorer();
      if (explorer) {
        openInTerminal(explorer.state.currentPath);
      }
    },
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
      dialogStore.openQuickOpen();
    },
  },
  {
    id: "general.openCommandPalette",
    label: "Command Palette",
    category: "general",
    shortcut: "Ctrl+Shift+P",
    handler: () => {
      dialogStore.openCommandPalette();
    },
  },
  {
    id: "general.openContentSearch",
    label: "Search in Files",
    category: "general",
    shortcut: "Ctrl+Shift+F",
    handler: () => {
      dialogStore.openContentSearch();
    },
  },
];

/** Register all commands */
export function registerAllCommands(): void {
  const allCommands = [
    ...navigationCommands,
    ...fileCommands,
    ...editCommands,
    ...selectionCommands,
    ...viewCommands,
    ...bookmarkCommands,
    ...recentCommands,
    ...windowCommands,
    ...tabCommands,
    ...crossPaneCommands,
    ...terminalCommands,
    ...workspaceCommands,
    ...generalCommands,
  ];

  // Register commands with the command registry
  registerCommands(allCommands);

  // Register default shortcuts with the keybindings store
  const defaultShortcuts: Record<string, string> = {};
  for (const cmd of allCommands) {
    if (cmd.shortcut) {
      defaultShortcuts[cmd.id] = cmd.shortcut;
    }
  }
  keybindingsStore.registerDefaults(defaultShortcuts);

  // Warn about shortcut conflicts at startup (dev only)
  if (import.meta.env.DEV) {
    validateShortcutConflicts(allCommands);
  }
}

/** Log warnings for commands sharing the same shortcut without `when` guards */
function validateShortcutConflicts(commands: Command[]): void {
  const byShortcut = new Map<string, Command[]>();
  for (const cmd of commands) {
    if (!cmd.shortcut) continue;
    const key = cmd.shortcut.toLowerCase();
    const group = byShortcut.get(key) ?? [];
    group.push(cmd);
    byShortcut.set(key, group);
  }
  for (const [shortcut, group] of byShortcut) {
    if (group.length <= 1) continue;
    const unguarded = group.filter((c) => !c.when);
    if (unguarded.length > 1) {
      console.warn(
        `[keybindings] Shortcut conflict: "${shortcut}" is bound to multiple commands without 'when' guards:`,
        unguarded.map((c) => c.id),
      );
    }
  }
}
