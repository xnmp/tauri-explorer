/**
 * View commands: view mode, sorting, zoom, toggles, theme.
 */

import type { Command } from "../commands.svelte";
import { settingsStore, generateToggleCommands } from "../settings.svelte";
import { themeStore } from "../theme.svelte";
import { folderViewsStore } from "../folder-views.svelte";
import { sidebarViewsStore } from "../sidebar-views.svelte";
import { dialogStore } from "../dialogs.svelte";
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
    id: "view.listColumnsAuto",
    label: "List View: Auto Columns",
    category: "view",
    handler: () => settingsStore.setListViewColumns(0),
  },
  {
    id: "view.listColumns1",
    label: "List View: 1 Column",
    category: "view",
    handler: () => settingsStore.setListViewColumns(1),
  },
  {
    id: "view.listColumns2",
    label: "List View: 2 Columns",
    category: "view",
    handler: () => settingsStore.setListViewColumns(2),
  },
  {
    id: "view.listColumns3",
    label: "List View: 3 Columns",
    category: "view",
    handler: () => settingsStore.setListViewColumns(3),
  },
  {
    id: "view.tilesSizeSmall",
    label: "Tiles: Small Icons (this folder)",
    category: "view",
    handler: () => { const e = getActiveExplorer(); if (e) { e.setViewMode("tiles"); folderViewsStore.set(e.currentPath, { thumbnailSize: "small" }); } },
  },
  {
    id: "view.tilesSizeMedium",
    label: "Tiles: Medium Icons (this folder)",
    category: "view",
    handler: () => { const e = getActiveExplorer(); if (e) { e.setViewMode("tiles"); folderViewsStore.set(e.currentPath, { thumbnailSize: "medium" }); } },
  },
  {
    id: "view.tilesSizeLarge",
    label: "Tiles: Large Icons (this folder)",
    category: "view",
    handler: () => { const e = getActiveExplorer(); if (e) { e.setViewMode("tiles"); folderViewsStore.set(e.currentPath, { thumbnailSize: "large" }); } },
  },
  {
    id: "view.tilesSizeXLarge",
    label: "Tiles: Extra Large Icons (this folder)",
    category: "view",
    handler: () => { const e = getActiveExplorer(); if (e) { e.setViewMode("tiles"); folderViewsStore.set(e.currentPath, { thumbnailSize: "xlarge" }); } },
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
