/**
 * View commands: view mode, sorting, zoom, toggles, theme.
 */

import type { Command } from "../commands.svelte";
import { settingsStore, generateToggleCommands } from "../settings.svelte";
import { themeStore } from "../theme.svelte";
import { DEFAULT_LAYOUT_ID, FLOATING_ISLANDS_LAYOUT_ID } from "$lib/domain/layout-theme-ids";
import { folderViewsStore } from "../folder-views.svelte";
import { folderTileSize } from "../folder-tile-size";
import { isThumbnailSize } from "$lib/domain/tile-layout";
import { sidebarViewsStore } from "../sidebar-views.svelte";
import { dialogStore } from "../dialogs.svelte";
import { terminalPanelStore } from "../terminal.svelte";
import { windowTabsManager } from "../window-tabs.svelte";
import { getActiveExplorer } from "./shared";
import { windowSizeStore } from "../window-size.svelte";
import { resolveAutoDockPosition } from "$lib/domain/preview-pane-position";
import type { ViewMode } from "$lib/domain/file";
import { fileViewRegistry } from "$lib/plugins/file-view-registry.svelte";

/** Choosing a built-in mode also leaves any plugin file view (SDK 2). */
function setBuiltInView(mode: ViewMode): void {
  const explorer = getActiveExplorer();
  if (!explorer) return;
  explorer.setViewMode(mode);
  windowTabsManager.setPaneFileView(windowTabsManager.activePaneId, null);
}

/** View commands */
export const viewCommands: Command[] = [
  {
    id: "view.peekFolder", scope: "pane", label: "Peek into Folder", category: "view",
    when: () => !!getActiveExplorer()?.peekCommandTarget,
    handler: () => { const explorer = getActiveExplorer(); if (explorer?.peekCommandTarget) return explorer.togglePeek(explorer.peekCommandTarget); },
  },
  {
    id: "view.collapseAllPeeks", scope: "pane", label: "Collapse All Peeks", category: "view",
    when: () => !!getActiveExplorer()?.peekEnabled,
    handler: () => getActiveExplorer()?.collapseAllPeeks(),
  },
  {
    id: "view.details",
    scope: "pane",
    label: "Details View",
    category: "view",
    handler: () => setBuiltInView("details"),
  },
  {
    id: "view.list",
    scope: "pane",
    label: "List View",
    category: "view",
    handler: () => setBuiltInView("list"),
  },
  {
    id: "view.tiles",
    scope: "pane",
    label: "Tiles View",
    category: "view",
    handler: () => setBuiltInView("tiles"),
  },
  {
    id: "view.setDefaultViewMode",
    scope: "pane",
    label: "Set Current View Mode as Default",
    category: "view",
    handler: () => {
      const explorer = getActiveExplorer();
      if (!explorer) return;
      settingsStore.setViewMode(explorer.state.viewMode);
      // Save what the pane shows, not a retained preference it cannot show here.
      settingsStore.setDefaultFileView(fileViewRegistry.resolve(explorer.fileView, explorer.currentPath)?.id ?? null);
    },
  },
  // Miller columns act on the focused pane only (#229); the global setting
  // (Settings dialog) remains the default for panes without a choice.
  {
    id: "view.toggleMillerColumns",
    scope: "pane",
    label: "Toggle Miller Columns",
    category: "view",
    shortcut: "Alt+M E",
    handler: () => getActiveExplorer()?.toggleMillerColumns(),
  },
  {
    id: "view.millerLayers0",
    scope: "pane",
    label: "Miller Columns: Off",
    category: "view",
    handler: () => getActiveExplorer()?.setMillerLayers(0),
  },
  {
    id: "view.millerLayers1",
    scope: "pane",
    label: "Miller Columns: 1 Layer",
    category: "view",
    handler: () => getActiveExplorer()?.setMillerLayers(1),
  },
  {
    id: "view.millerLayers2",
    scope: "pane",
    label: "Miller Columns: 2 Layers",
    category: "view",
    handler: () => getActiveExplorer()?.setMillerLayers(2),
  },
  {
    id: "view.millerLayers3",
    scope: "pane",
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
    scope: "pane",
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
    scope: "pane",
    label: "Sort by Name",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("name"),
  },
  {
    id: "view.sortByDateModified",
    scope: "pane",
    label: "Sort by Date Modified",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("modified"),
  },
  {
    id: "view.sortBySize",
    scope: "pane",
    label: "Sort by Size",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("size"),
  },
  {
    id: "view.sortByType",
    scope: "pane",
    label: "Sort by Type",
    category: "view",
    handler: () => getActiveExplorer()?.setSorting("type"),
  },
  {
    id: "view.focusFilesSidebar",
    scope: "window",
    label: "Toggle Files Sidebar (Bookmarks & Recent)",
    category: "view",
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
    scope: "window",
    label: "Toggle Dark/Light Theme",
    category: "view",
    handler: () => {
      const current = themeStore.currentThemeId;
      themeStore.setTheme(current === "dark" ? "light" : "dark");
    },
  },
  {
    id: "view.toggleTerminal",
    scope: "pane",
    label: "Toggle Terminal",
    category: "view",
    handler: () => terminalPanelStore.toggle(),
    when: () => settingsStore.enableTerminal,
  },
  {
    id: "view.zoomIn",
    scope: "window",
    label: "Zoom In",
    category: "view",
    shortcut: "Ctrl+=",
    handler: () => settingsStore.zoomIn(),
  },
  {
    id: "view.zoomOut",
    scope: "window",
    label: "Zoom Out",
    category: "view",
    shortcut: "Ctrl+-",
    handler: () => settingsStore.zoomOut(),
  },
  {
    id: "view.zoomReset",
    scope: "window",
    label: "Reset Zoom",
    category: "view",
    shortcut: "Ctrl+0",
    handler: () => settingsStore.zoomReset(),
  },
  {
    id: "view.setListColumns",
    scope: "pane",
    label: "Set List View Column Count",
    category: "view",
    // Classic List only: Folder Peek's column flow sizes itself from the pane height.
    when: () => !settingsStore.folderPeek,
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
    scope: "pane",
    label: "Tile View: Set Size",
    category: "view",
    handler: () => {
      const e = getActiveExplorer();
      const currentSize = e ? folderTileSize(e.currentPath) : settingsStore.thumbnailSize;
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
          if (!explorer || !isThumbnailSize(id)) return;
          // A plugin file view sizes its tiles from `pane.tileSize`, so it
          // stays, as with the context menu's Icon Size; a built-in mode
          // switches to Tiles to show the new size.
          if (!explorer.showsPluginView) setBuiltInView("tiles");
          folderViewsStore.set(explorer.currentPath, { thumbnailSize: id });
        },
      });
    },
  },
  {
    id: "view.switchTheme",
    scope: "window",
    label: "Switch Theme...",
    category: "view",
    handler: () => dialogStore.openThemePicker(),
  },
  {
    id: "view.switchLayout",
    scope: "window",
    label: "Switch Layout...",
    category: "view",
    handler: () => dialogStore.openThemePicker("layout"),
  },
  {
    // Keeps the id of the retired floatingIslands toggle so existing
    // keybindings still work; it now switches the layout theme (#1306).
    id: "setting.toggle.floatingIslands",
    scope: "window",
    label: "Toggle Floating Islands Layout",
    category: "view",
    toggleState: () => settingsStore.layoutTheme === FLOATING_ISLANDS_LAYOUT_ID,
    handler: () => settingsStore.update({
      layoutTheme: settingsStore.layoutTheme === FLOATING_ISLANDS_LAYOUT_ID ? DEFAULT_LAYOUT_ID : FLOATING_ISLANDS_LAYOUT_ID,
    }),
  },
  {
    id: 'view.switchIconTheme',
    scope: 'window',
    label: 'Switch Icon Theme...',
    category: 'view',
    handler: () => dialogStore.openThemePicker('icon'),
  },
  // Preview pane dock position (#460). Cycling (or jumping to any edge) also
  // reveals the pane when hidden, so the command has a visible effect.
  {
    id: "view.cyclePreviewPanePosition",
    scope: "pane",
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
    scope: "pane",
    label: "Dock Preview Pane Right",
    category: "view",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.setPreviewPanePosition("right");
    },
  },
  {
    id: "view.previewPanePositionBottom",
    scope: "pane",
    label: "Dock Preview Pane Bottom",
    category: "view",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.setPreviewPanePosition("bottom");
    },
  },
  {
    id: "view.previewPanePositionTop",
    scope: "pane",
    label: "Dock Preview Pane Top",
    category: "view",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.setPreviewPanePosition("top");
    },
  },
  {
    id: "view.previewPanePositionAuto",
    scope: "pane",
    // Getter, not a plain string: re-evaluated on every palette render/filter
    // so the currently-resolved side stays live as the window is resized,
    // without needing a dynamic-label field on Command (#467).
    get label() {
      const resolved = resolveAutoDockPosition(windowSizeStore.width, windowSizeStore.height);
      return `Dock Preview Pane Auto (currently ${resolved})`;
    },
    category: "view",
    toggleState: () => settingsStore.previewPanePosition === "auto",
    handler: () => {
      settingsStore.openPreviewPane();
      settingsStore.setPreviewPanePosition("auto");
    },
  },
  // Auto-generated toggle commands from TOGGLE_SETTINGS metadata
  ...generateToggleCommands(),
];
