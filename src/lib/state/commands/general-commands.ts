/**
 * General commands: window, tabs, bookmarks, recent, workspace, terminal, dialogs.
 */

import type { Command } from "../commands.svelte";
import { windowTabsManager } from "../window-tabs.svelte";
import { settingsStore } from "../settings.svelte";
import { bookmarksStore } from "../bookmarks.svelte";
import { workspacesStore } from "../workspaces.svelte";
import { recentFilesStore } from "../recent-files.svelte";
import { dialogStore } from "../dialogs.svelte";
import { terminalPanelStore } from "../terminal.svelte";
import { openInTerminal, gitRepoRoot } from "$lib/api/files";
import { gitFetch } from "$lib/api/git-log";
import { notifyLocalGitChange } from "$lib/state/git-refresh";
import { runGitNetworkOperation } from "$lib/state/git-graph-refresh";
import { toastStore } from "../toast.svelte";
import { readFocusedWindowState } from "../focused-window";
import { getActiveExplorer, openNewWindow } from "./shared";
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
    // Ghostty-style (#229): closes the focused pane when the active tab has
    // several, otherwise closes the tab.
    id: "surface.close",
    label: "Close Surface",
    category: "general",
    shortcut: "Ctrl+W",
    handler: () => windowTabsManager.closeSurface(),
  },
  {
    id: "tabs.closeTab",
    label: "Close Tab",
    category: "general",
    shortcut: "Ctrl+Shift+W",
    handler: () => windowTabsManager.closeActiveTab(),
  },
  {
    // Restores the most recently closed pane back into its split position;
    // restores the last closed tab when that close is more recent (#229).
    id: "tabs.restoreClosedTab",
    label: "Restore Closed Pane or Tab",
    category: "general",
    shortcut: "Ctrl+Shift+T",
    handler: () => {
      const result = windowTabsManager.restoreClosedSurface();
      if (result && result.openInNewWindow) {
        openNewWindow(result.openInNewWindow);
      }
    },
    when: () => windowTabsManager.canRestoreSurface,
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

/** Git graph command (#51, #272): toggle the repo's commit graph in the
 *  active pane — on when browsing a repo, off again from within the graph. */
export const gitGraphCommands: Command[] = [
  {
    id: "git.showGraph",
    label: "Git: Toggle Commit Graph",
    category: "general",
    shortcut: "Ctrl+Alt+G",
    when: () => settingsStore.enableGitGraph,
    handler: async () => {
      const tab = windowTabsManager.activeTab;
      if (tab?.panes[tab.activePaneId]?.gitGraph) {
        windowTabsManager.toggleGitGraphInActivePane(null);
        return;
      }
      const path = getActiveExplorer()?.state.currentPath;
      if (!path) return;
      const root = await gitRepoRoot(path);
      if (root.ok && root.data) {
        windowTabsManager.toggleGitGraphInActivePane(root.data);
      } else {
        toastStore.show("Not inside a git repository", "info");
      }
    },
  },
  {
    id: "git.fetch",
    label: "Git: Fetch from Origin",
    category: "general",
    handler: async () => {
      const path = getActiveExplorer()?.state.currentPath;
      if (!path) return;
      const root = await gitRepoRoot(path);
      if (!root.ok || !root.data) {
        toastStore.show("Not inside a git repository", "info");
        return;
      }
      try {
        await runGitNetworkOperation(root.data, "fetch", (taskId) =>
          gitFetch(root.data!, taskId),
        );
        toastStore.success("Fetched from remotes");
        // The repo watcher (git graph, SCM panel, badges) picks up the new
        // refs; announce for consumers without a watcher.
        notifyLocalGitChange(root.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/git network operation cancelled/i.test(message)) {
          toastStore.show("Git fetch cancelled", "info");
        } else {
          toastStore.error(message);
        }
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
    // One palette entry (#229): opens a second menu listing the saved
    // workspaces; picking one restores its layout.
    id: "workspace.openNamed",
    label: "Workspaces: Open...",
    category: "general",
    when: () => workspacesStore.count > 0,
    handler: () => {
      dialogStore.openPicker({
        title: "Open workspace",
        options: workspacesStore.list.map((w) => ({ id: w.id, label: w.name })),
        onSelect: (id) => {
          const workspace = workspacesStore.get(id);
          if (workspace) windowTabsManager.restoreFromState(workspace.state);
        },
      });
    },
  },
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
    label: "Terminal Here",
    category: "general",
    shortcut: "Alt+M T",
    handler: () => {
      // With the integrated terminal enabled, "here" means the embedded panel
      // (it starts in the active explorer's directory) and the shortcut
      // toggles it like Ctrl+` (#250); otherwise fall back to the external
      // terminal app (#237).
      if (settingsStore.enableTerminal) {
        terminalPanelStore.toggle();
        return;
      }
      const explorer = getActiveExplorer();
      if (explorer) {
        openInTerminal(explorer.state.currentPath, settingsStore.terminalApp);
      }
    },
  },
  {
    id: "general.insertPathsIntoTerminal",
    label: "Insert Selected Paths into Terminal",
    category: "general",
    shortcut: "Alt+T",
    when: () => settingsStore.enableTerminal,
    handler: () => {
      // Type the selection (space-delimited, shell-quoted) into the shell
      // prompt and focus it, opening the panel if hidden (#265).
      const explorer = getActiveExplorer();
      const paths = explorer?.getSelectedEntries().map((e) => e.path) ?? [];
      terminalPanelStore.insertPaths(paths);
    },
  },
];

/** General dialog commands */
export const generalDialogCommands: Command[] = [
  {
    id: "help.reportIssue",
    label: "Report Issue",
    category: "general",
    shortcut: "Alt+I",
    handler: () => {
      dialogStore.openUserReport();
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
