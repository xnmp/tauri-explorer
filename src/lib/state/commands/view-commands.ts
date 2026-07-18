/**
 * View commands: view mode, sorting, zoom, toggles, theme.
 */

import type { Command } from "../commands.svelte";
import { settingsStore, generateToggleCommands } from "../settings.svelte";
import { themeStore } from "../theme.svelte";
import { folderViewsStore } from "../folder-views.svelte";
import { sidebarViewsStore } from "../sidebar-views.svelte";
import { dialogStore } from "../dialogs.svelte";
import { terminalPanelStore } from "../terminal.svelte";
import { windowTabsManager } from "../window-tabs.svelte";
import { getActiveExplorer } from "./shared";

/** View commands */
export const viewCommands: Command[] = [
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
    id: "view.setDefaultViewMode",
    label: "Set Current View Mode as Default",
    category: "view",
    handler: () => {
      const mode = getActiveExplorer()?.state.viewMode;
      if (mode) settingsStore.setViewMode(mode);
    },
  },
  // Miller columns act on the focused pane only (#229); the global setting
  // (Settings dialog) remains the default for panes without a choice.
  {
    id: "view.toggleMillerColumns",
    label: "Toggle Miller Columns",
    category: "view",
    shortcut: "Alt+M E",
    handler: () => getActiveExplorer()?.toggleMillerColumns(),
  },
  {
    id: "view.millerLayers0",
    label: "Miller Columns: Off",
    category: "view",
    handler: () => getActiveExplorer()?.setMillerLayers(0),
  },
  {
    id: "view.millerLayers1",
    label: "Miller Columns: 1 Layer",
    category: "view",
    handler: () => getActiveExplorer()?.setMillerLayers(1),
  },
  {
    id: "view.millerLayers2",
    label: "Miller Columns: 2 Layers",
    category: "view",
    handler: () => getActiveExplorer()?.setMillerLayers(2),
  },
  {
    id: "view.millerLayers3",
    label: "Miller Columns: 3 Layers",
    category: "view",
    handler: () => getActiveExplorer()?.setMillerLayers(3),
  },
  // SCM panel visibility is per-pane (#434): the toggle acts on the active
  // pane only, so panes on different repos (or the same one) open/close their
  // git panels independently. Opening also enables the global git-status
  // indicators the panel depends on.
  {
    id: "view.toggleScmPanel",
    label: "Toggle Source Control Panel",
    category: "view",
    shortcut: "Alt+M G",
    handler: () => {
      const opened = windowTabsManager.toggleScmInActivePane();
      if (opened) {
        if (!settingsStore.showGitStatus) settingsStore.update({ showGitStatus: true });
      } else {
        import("../scm.svelte").then((m) => m.closeAllDiffs());
      }
    },
  },
  {
    id: "view.sortByName",
    label: "Sort by Name",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("name"),
  },
  {
    id: "view.sortByDateModified",
    label: "Sort by Date Modified",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("modified"),
  },
  {
    id: "view.sortBySize",
    label: "Sort by Size",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("size"),
  },
  {
    id: "view.sortByType",
    label: "Sort by Type",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("type"),
  },
  {
    id: "view.focusFilesSidebar",
    label: "Toggle Files Sidebar (Bookmarks & Recent)",
    category: "view",
    shortcut: "Alt+M B",
    handler: () => {
      if (settingsStore.showSidebar && sidebarViewsStore.activeId === "files") {
        settingsStore.toggleSidebar();
      } else {
        if (!settingsStore.showSidebar) settingsStore.toggleSidebar();
        sidebarViewsStore.setActive("files");
      }
    },
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
    id: "view.toggleTerminal",
    label: "Toggle Terminal",
    category: "view",
    // Display only: Ctrl+` is hardcoded in +page.svelte's keydown handler so
    // it works even while the terminal's own textarea has focus.
    shortcut: "Ctrl+`",
    handler: () => terminalPanelStore.toggle(),
    when: () => settingsStore.enableTerminal,
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
    id: "view.setListColumns",
    label: "Set List View Column Count",
    category: "view",
    handler: () => {
      const current = settingsStore.listViewColumns;
      dialogStore.openPicker({
        title: "Select column count",
        options: [
          { id: "0", label: "Auto", current: current === 0 },
          { id: "1", label: "1 Column", current: current === 1 },
          { id: "2", label: "2 Columns", current: current === 2 },
          { id: "3", label: "3 Columns", current: current === 3 },
          { id: "4", label: "4 Columns", current: current === 4 },
        ],
        onSelect: (id) => settingsStore.setListViewColumns(Number(id)),
      });
    },
  },
  {
    id: "view.setTileSize",
    label: "Tile View: Set Size",
    category: "view",
    handler: () => {
      const e = getActiveExplorer();
      const currentSize = e ? (folderViewsStore.get(e.currentPath)?.thumbnailSize ?? settingsStore.state.thumbnailSize) : settingsStore.state.thumbnailSize;
      dialogStore.openPicker({
        title: "Select tile size",
        options: [
          { id: "small", label: "Small", current: currentSize === "small" },
          { id: "medium", label: "Medium", current: currentSize === "medium" },
          { id: "large", label: "Large", current: currentSize === "large" },
          { id: "xlarge", label: "Extra Large", current: currentSize === "xlarge" },
        ],
        onSelect: (id) => {
          const explorer = getActiveExplorer();
          if (explorer) {
            explorer.setViewMode("tiles");
            folderViewsStore.set(explorer.currentPath, { thumbnailSize: id as "small" | "medium" | "large" | "xlarge" });
          }
        },
      });
    },
  },
  {
    id: "view.switchTheme",
    label: "Switch Theme...",
    category: "view",
    handler: () => dialogStore.openThemePicker(),
  },
  // Preview pane dock position (#460). Cycling (or jumping to any edge) also
  // reveals the pane when hidden, so the command has a visible effect.
  {
    id: "view.cyclePreviewPanePosition",
    label: "Cycle Preview Pane Position",
    category: "view",
    shortcut: "Alt+Shift+P",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.cyclePreviewPanePosition();
    },
  },
  {
    id: "view.previewPanePositionRight",
    label: "Dock Preview Pane Right",
    category: "view",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.setPreviewPanePosition("right");
    },
  },
  {
    id: "view.previewPanePositionBottom",
    label: "Dock Preview Pane Bottom",
    category: "view",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.setPreviewPanePosition("bottom");
    },
  },
  {
    id: "view.previewPanePositionTop",
    label: "Dock Preview Pane Top",
    category: "view",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.setPreviewPanePosition("top");
    },
  },
  // Auto-generated toggle commands from TOGGLE_SETTINGS metadata
  ...generateToggleCommands(),
];
