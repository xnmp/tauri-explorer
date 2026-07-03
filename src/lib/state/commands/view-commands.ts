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
    id: "view.toggleMillerColumns",
    label: "Toggle Miller Columns",
    category: "view",
    shortcut: "Alt+M E",
    handler: () => settingsStore.toggleMillerColumns(),
  },
  {
    id: "view.millerLayers0",
    label: "Miller Columns: Off",
    category: "view",
    handler: () => settingsStore.setMillerLayers(0),
  },
  {
    id: "view.millerLayers1",
    label: "Miller Columns: 1 Layer",
    category: "view",
    handler: () => settingsStore.setMillerLayers(1),
  },
  {
    id: "view.millerLayers2",
    label: "Miller Columns: 2 Layers",
    category: "view",
    handler: () => settingsStore.setMillerLayers(2),
  },
  {
    id: "view.millerLayers3",
    label: "Miller Columns: 3 Layers",
    category: "view",
    handler: () => settingsStore.setMillerLayers(3),
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
  // Auto-generated toggle commands from TOGGLE_SETTINGS metadata
  ...generateToggleCommands(),
];
