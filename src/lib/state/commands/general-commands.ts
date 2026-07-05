/**
 * General commands: window, tabs, bookmarks, recent, workspace, terminal, dialogs.
 */

import type { Command } from "../commands.svelte";
import { windowTabsManager } from "../window-tabs.svelte";
import { settingsStore } from "../settings.svelte";
import { bookmarksStore } from "../bookmarks.svelte";
import { recentFilesStore } from "../recent-files.svelte";
import { dialogStore } from "../dialogs.svelte";
import { openInTerminal, gitRepoRoot } from "$lib/api/files";
import { toastStore } from "../toast.svelte";
import { readFocusedWindowState } from "../focused-window";
import { getActiveExplorer, openNewWindow } from "./shared";
import { getAppInfo, bugReportUrl, openExternalUrl } from "$lib/api/crash";
import { getLogDir } from "$lib/api/files";

/** Window commands */
export const windowCommands: Command[] = [
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
export const tabCommands: Command[] = [
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
    id: "tabs.nextTabAlt",
    label: "Next Tab",
    category: "general",
    shortcut: "Ctrl+PageDown",
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
  {
    id: "tabs.prevTabAlt",
    label: "Previous Tab",
    category: "general",
    shortcut: "Ctrl+PageUp",
    handler: () => windowTabsManager.prevTab(),
    when: () => windowTabsManager.tabs.length > 1,
  },
];

/** Git graph command (#51): open the repo's commit graph as a tab. */
export const gitGraphCommands: Command[] = [
  {
    id: "git.showGraph",
    label: "Git: Show Commit Graph",
    category: "general",
    shortcut: "Ctrl+Alt+G",
    when: () => settingsStore.enableGitGraph,
    handler: async () => {
      const path = getActiveExplorer()?.state.currentPath;
      if (!path) return;
      const root = await gitRepoRoot(path);
      if (root.ok && root.data) {
        windowTabsManager.openGitGraphTab(root.data);
      } else {
        toastStore.show("Not inside a git repository", "info");
      }
    },
  },
];

/** Bookmark commands */
export const bookmarkCommands: Command[] = [
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

/** Recent files commands */
export const recentCommands: Command[] = [
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
export const workspaceCommands: Command[] = [
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
export const terminalCommands: Command[] = [
  {
    id: "general.openTerminal",
    label: "Open Terminal Here",
    category: "general",
    shortcut: "Alt+M T",
    handler: () => {
      const explorer = getActiveExplorer();
      if (explorer) {
        openInTerminal(explorer.state.currentPath, settingsStore.terminalApp);
      }
    },
  },
];

/** General dialog commands */
export const generalDialogCommands: Command[] = [
  {
    id: "help.reportBug",
    label: "Report a Bug",
    category: "general",
    handler: async () => {
      const info = await getAppInfo();
      await openExternalUrl(bugReportUrl(info));
    },
  },
  {
    id: "help.openLogs",
    label: "Open Logs Folder",
    category: "general",
    handler: async () => {
      const dir = await getLogDir();
      await getActiveExplorer()?.navigateTo(dir);
    },
  },
  {
    id: "help.shortcuts",
    label: "Keyboard Shortcuts",
    category: "general",
    shortcut: "Ctrl+/",
    handler: () => {
      dialogStore.openShortcuts();
    },
  },
  {
    id: "general.openQuickOpen",
    label: "Quick Open",
    category: "general",
    shortcut: "Ctrl+P",
    hidden: true,
    handler: () => {
      dialogStore.openQuickOpen();
    },
  },
  {
    id: "general.openCommandPalette",
    label: "Command Palette",
    category: "general",
    shortcut: "Ctrl+Shift+P",
    hidden: true,
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
  {
    id: "general.filterCurrentDir",
    label: "Filter Current Directory",
    category: "general",
    shortcut: "Ctrl+F",
    handler: () => {
      const explorer = getActiveExplorer();
      explorer?.openFilter();
    },
  },
];
