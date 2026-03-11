/**
 * Settings state management using Svelte 5 runes.
 * Issue: tauri-explorer-npjh
 *
 * Stores UI preferences and hotkey customization.
 * Persisted to localStorage.
 */

import { loadPersisted, savePersisted } from "./persisted";

/** Which navigation bar buttons to display */
export interface NavBarButtons {
  back: boolean;
  forward: boolean;
  up: boolean;
  refresh: boolean;
}

export type IconTheme = "default" | "material" | "minimal";

/** Which columns are visible in details view (name is always shown) */
export interface ColumnVisibility {
  date: boolean;
  type: boolean;
  size: boolean;
}

export interface Settings {
  showToolbar: boolean;
  showSidebar: boolean;
  showHidden: boolean;
  showWindowControls: boolean;
  showPreviewPane: boolean;
  confirmDelete: boolean;
  zoomLevel: number; // percentage, e.g. 100 = 100%
  terminalApp: string; // terminal emulator command, empty = auto-detect
  backgroundOpacity: number; // 0-100, percentage of background opacity
  navBarButtons: NavBarButtons;
  showStatusBar: boolean;
  iconTheme: IconTheme;
  backgroundImage: string; // absolute path to wallpaper image, empty = none
  backgroundBlur: number; // 0-20, blur in px for custom wallpaper
  columnVisibility: ColumnVisibility;
  listViewColumns: number; // 0 = auto (based on window width), 1-6 = fixed
  listColumnMaxWidth: number; // max width per column in px (used when listViewColumns=0)
}

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;

const DEFAULT_SETTINGS: Settings = {
  showToolbar: true,
  showSidebar: true,
  showHidden: false,
  showWindowControls: true,
  showPreviewPane: false,
  confirmDelete: true,
  zoomLevel: 100,
  terminalApp: "",
  backgroundOpacity: 100,
  navBarButtons: {
    back: true,
    forward: true,
    up: true,
    refresh: false, // omitted by default per tauri-k4ec
  },
  showStatusBar: true,
  iconTheme: "default",
  backgroundImage: "",
  backgroundBlur: 0,
  columnVisibility: { date: true, type: true, size: true },
  listViewColumns: 0,
  listColumnMaxWidth: 250,
};

const STORAGE_KEY = "explorer-settings";

function loadSettings(): Settings {
  const saved = loadPersisted<Partial<Settings>>(STORAGE_KEY, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(settings: Settings): void {
  savePersisted(STORAGE_KEY, settings);
}

function createSettingsStore() {
  let settings = $state<Settings>(loadSettings());

  function update(partial: Partial<Settings>): void {
    settings = { ...settings, ...partial };
    saveSettings(settings);
  }

  function toggleToolbar(): void {
    update({ showToolbar: !settings.showToolbar });
  }

  function toggleSidebar(): void {
    update({ showSidebar: !settings.showSidebar });
  }

  function toggleHidden(): void {
    update({ showHidden: !settings.showHidden });
  }

  function toggleWindowControls(): void {
    update({ showWindowControls: !settings.showWindowControls });
  }

  function togglePreviewPane(): void {
    update({ showPreviewPane: !settings.showPreviewPane });
  }

  function toggleConfirmDelete(): void {
    update({ confirmDelete: !settings.confirmDelete });
  }

  function zoomIn(): void {
    update({ zoomLevel: Math.min(MAX_ZOOM, settings.zoomLevel + ZOOM_STEP) });
  }

  function zoomOut(): void {
    update({ zoomLevel: Math.max(MIN_ZOOM, settings.zoomLevel - ZOOM_STEP) });
  }

  function zoomReset(): void {
    update({ zoomLevel: DEFAULT_SETTINGS.zoomLevel });
  }

  function reset(): void {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings(settings);
  }

  return {
    get state() {
      return settings;
    },
    get showToolbar() {
      return settings.showToolbar;
    },
    get showSidebar() {
      return settings.showSidebar;
    },
    get showHidden() {
      return settings.showHidden;
    },
    get showWindowControls() {
      return settings.showWindowControls;
    },
    get showPreviewPane() {
      return settings.showPreviewPane;
    },
    get confirmDelete() {
      return settings.confirmDelete;
    },
    get zoomLevel() {
      return settings.zoomLevel;
    },
    get terminalApp() {
      return settings.terminalApp;
    },
    get backgroundOpacity() {
      return settings.backgroundOpacity;
    },
    get navBarButtons() {
      return settings.navBarButtons;
    },
    get showStatusBar() {
      return settings.showStatusBar;
    },
    get iconTheme() {
      return settings.iconTheme;
    },
    get backgroundImage() {
      return settings.backgroundImage;
    },
    get backgroundBlur() {
      return settings.backgroundBlur;
    },
    get columnVisibility() {
      return settings.columnVisibility;
    },
    get listViewColumns() {
      return settings.listViewColumns;
    },
    get listColumnMaxWidth() {
      return settings.listColumnMaxWidth;
    },
    setListViewColumns(n: number): void {
      update({ listViewColumns: Math.max(0, Math.min(6, n)) });
    },
    setListColumnMaxWidth(px: number): void {
      update({ listColumnMaxWidth: Math.max(100, Math.min(600, px)) });
    },
    toggleColumn(column: keyof ColumnVisibility): void {
      update({
        columnVisibility: {
          ...settings.columnVisibility,
          [column]: !settings.columnVisibility[column],
        },
      });
    },
    /** Effective icon theme: user setting wins; if "default", check --theme-icon-pack CSS var */
    get effectiveIconTheme(): IconTheme {
      if (settings.iconTheme !== "default") return settings.iconTheme;
      if (typeof document === "undefined") return "default";
      const css = getComputedStyle(document.documentElement).getPropertyValue("--theme-icon-pack").trim().replace(/["']/g, "");
      if (css === "material" || css === "minimal") return css;
      return "default";
    },
    toggleStatusBar(): void {
      update({ showStatusBar: !settings.showStatusBar });
    },
    toggleNavButton(button: keyof NavBarButtons): void {
      update({
        navBarButtons: {
          ...settings.navBarButtons,
          [button]: !settings.navBarButtons[button],
        },
      });
    },
    update,
    toggleToolbar,
    toggleSidebar,
    toggleHidden,
    toggleWindowControls,
    togglePreviewPane,
    toggleConfirmDelete,
    zoomIn,
    zoomOut,
    zoomReset,
    reset,
  };
}

export const settingsStore = createSettingsStore();
