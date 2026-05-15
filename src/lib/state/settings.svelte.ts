/**
 * Settings state management using Svelte 5 runes.
 * Issue: tauri-explorer-npjh
 *
 * Stores UI preferences and hotkey customization.
 * Persisted to ~/.config/tauri-explorer/settings.json with
 * localStorage as synchronous fallback for immediate state.
 */

import { loadPersisted, savePersisted } from "./persisted";
import { readConfigFile, writeConfigFile } from "$lib/api/files";
import type { ViewMode } from "./types";

/** Which navigation bar buttons to display */
export interface NavBarButtons {
  back: boolean;
  forward: boolean;
  up: boolean;
  refresh: boolean;
}

export type IconTheme = "default" | "material" | "minimal";

export type ThumbnailSize = "small" | "medium" | "large";

export interface ThumbnailSizeConfig {
  displaySize: number;
  genSize: number;
  quality: number;
  gridMinWidth: number;
}

export const THUMBNAIL_SIZE_CONFIG: Record<ThumbnailSize, ThumbnailSizeConfig> = {
  small:  { displaySize: 64,  genSize: 128, quality: 80, gridMinWidth: 108 },
  medium: { displaySize: 96,  genSize: 192, quality: 85, gridMinWidth: 140 },
  large:  { displaySize: 128, genSize: 256, quality: 90, gridMinWidth: 172 },
};

/** Which columns are visible in details view (name is always shown) */
export interface ColumnVisibility {
  date: boolean;
  type: boolean;
  size: boolean;
}

export interface Settings {
  showSidebar: boolean;
  showHidden: boolean;
  showWindowControls: boolean;
  showAddressBar: boolean;
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
  viewMode: ViewMode; // default view mode for new panes
  previewPaneWidth: number; // width in px, 0 = default (280px)
  theme: string; // active theme id, e.g. "dark", "golden-hour"
  thumbnailSize: ThumbnailSize; // tile thumbnail size tier
  showGitStatus: boolean; // show git indicators on files
  recentItemsCount: number; // number of recent locations in sidebar (0 = hidden)
  millerLayers: number; // 0-3, number of ancestor columns in miller view
  millerLayersPreferred: number; // 1-3, remembered layer count for toggle
  millerHideEmpty: boolean; // hide folders containing no visible entries from miller columns
  showManuallyHidden: boolean; // reveal manually-hidden entries (dimmed)
  showScmPanel: boolean; // show SCM panel (independent of sidebar)
  scmTreeView: boolean; // group SCM file rows by folder hierarchy
  quickOpenDebug: boolean; // show score breakdown in QuickOpen results
  geminiApiKey: string; // Gemini API key for Nano Banana image editing
  integratedTitleBar: boolean; // macOS: render tabs in title bar with overlay traffic lights
  macOsVibrancy: boolean; // macOS: native window vibrancy (translucent frosted glass), requires restart
  vibrancyBlur: boolean; // macOS: enable native blur behind vibrancy (off = theme background, no blur)
  yaziNavigation: boolean; // left/right arrows navigate up/into folders in details/list view
}

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;

const DEFAULT_SETTINGS: Settings = {
  showSidebar: true,
  showHidden: false,
  showWindowControls: true,
  showAddressBar: true,
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
  viewMode: "details",
  previewPaneWidth: 0,
  theme: "light",
  thumbnailSize: "small",
  showGitStatus: false,
  recentItemsCount: 6,
  millerLayers: 0,
  millerLayersPreferred: 2,
  millerHideEmpty: false,
  showManuallyHidden: false,
  showScmPanel: false,
  scmTreeView: false,
  quickOpenDebug: false,
  geminiApiKey: "",
  integratedTitleBar: false,
  macOsVibrancy: false,
  vibrancyBlur: true,
  yaziNavigation: true,
};

const STORAGE_KEY = "explorer-settings";
const CONFIG_FILENAME = "settings.json";

function loadSettings(): Settings {
  const saved = loadPersisted<Partial<Settings>>(STORAGE_KEY, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(settings: Settings): void {
  savePersisted(STORAGE_KEY, settings);
  writeConfigFile(CONFIG_FILENAME, JSON.stringify(settings, null, 2)).catch((err) => {
    console.warn("Failed to save settings to config file:", err);
  });
}

function createSettingsStore() {
  let settings = $state<Settings>(loadSettings());

  /**
   * Load settings from config file, migrating from localStorage if needed.
   * Called once during app initialization.
   */
  async function init() {
    try {
      const result = await readConfigFile(CONFIG_FILENAME);
      if (result.ok && result.data) {
        const loaded = JSON.parse(result.data) as Partial<Settings>;
        if (loaded && typeof loaded === "object") {
          settings = { ...DEFAULT_SETTINGS, ...loaded };
          savePersisted(STORAGE_KEY, settings);
          return;
        }
      }
    } catch {
      // Config file doesn't exist or is invalid - fall through
    }

    // If config file was empty but localStorage has data, migrate
    const saved = loadPersisted<Partial<Settings>>(STORAGE_KEY, {});
    if (Object.keys(saved).length > 0) {
      writeConfigFile(CONFIG_FILENAME, JSON.stringify(settings, null, 2)).catch(() => {});
    }
  }

  function update(partial: Partial<Settings>): void {
    settings = { ...settings, ...partial };
    saveSettings(settings);
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

  function toggleAddressBar(): void {
    update({ showAddressBar: !settings.showAddressBar });
  }

  function togglePreviewPane(): void {
    update({ showPreviewPane: !settings.showPreviewPane });
  }

  function openPreviewPane(): void {
    if (!settings.showPreviewPane) update({ showPreviewPane: true });
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
    get showSidebar() {
      return settings.showSidebar;
    },
    get showHidden() {
      return settings.showHidden;
    },
    get showWindowControls() {
      return settings.showWindowControls;
    },
    get showAddressBar() {
      return settings.showAddressBar;
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
    get viewMode() {
      return settings.viewMode;
    },
    get previewPaneWidth() {
      return settings.previewPaneWidth;
    },
    get theme() {
      return settings.theme;
    },
    get thumbnailSize() {
      return settings.thumbnailSize;
    },
    get showGitStatus() {
      return settings.showGitStatus;
    },
    toggleGitStatus(): void {
      update({ showGitStatus: !settings.showGitStatus });
    },
    get recentItemsCount() {
      return settings.recentItemsCount;
    },
    setRecentItemsCount(count: number): void {
      update({ recentItemsCount: Math.max(0, Math.min(20, count)) });
    },
    get millerLayers() {
      return settings.millerLayers;
    },
    setMillerLayers(n: number): void {
      const clamped = Math.max(0, Math.min(3, n));
      const updates: Partial<Settings> = { millerLayers: clamped };
      if (clamped > 0) updates.millerLayersPreferred = clamped;
      update(updates);
    },
    get millerHideEmpty() {
      return settings.millerHideEmpty;
    },
    toggleMillerHideEmpty(): void {
      update({ millerHideEmpty: !settings.millerHideEmpty });
    },
    get showManuallyHidden() {
      return settings.showManuallyHidden;
    },
    toggleShowManuallyHidden(): void {
      update({ showManuallyHidden: !settings.showManuallyHidden });
    },
    get showScmPanel() {
      return settings.showScmPanel;
    },
    toggleScmPanel(): void {
      const opening = !settings.showScmPanel;
      update({ showScmPanel: opening, ...(opening && !settings.showGitStatus ? { showGitStatus: true } : {}) });
    },
    get scmTreeView() {
      return settings.scmTreeView;
    },
    toggleScmTreeView(): void {
      update({ scmTreeView: !settings.scmTreeView });
    },
    get quickOpenDebug() {
      return settings.quickOpenDebug;
    },
    toggleQuickOpenDebug(): void {
      update({ quickOpenDebug: !settings.quickOpenDebug });
    },
    get geminiApiKey() {
      return settings.geminiApiKey;
    },
    setGeminiApiKey(key: string): void {
      update({ geminiApiKey: key });
    },
    get integratedTitleBar() {
      return settings.integratedTitleBar;
    },
    get macOsVibrancy() {
      return settings.macOsVibrancy;
    },
    get vibrancyBlur() {
      return settings.vibrancyBlur;
    },
    get yaziNavigation() {
      return settings.yaziNavigation;
    },
    toggleMillerColumns(): void {
      const on = settings.millerLayers > 0;
      update({ millerLayers: on ? 0 : settings.millerLayersPreferred });
    },
    setTheme(themeId: string): void {
      update({ theme: themeId });
    },
    setPreviewPaneWidth(px: number): void {
      update({ previewPaneWidth: Math.max(0, Math.min(600, px)) });
    },
    setViewMode(mode: ViewMode): void {
      update({ viewMode: mode });
    },
    setListViewColumns(n: number): void {
      update({ listViewColumns: Math.max(0, Math.min(3, n)) });
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
    init,
    update,
    toggleSidebar,
    toggleHidden,
    toggleWindowControls,
    toggleAddressBar,
    togglePreviewPane,
    openPreviewPane,
    toggleConfirmDelete,
    zoomIn,
    zoomOut,
    zoomReset,
    reset,
  };
}

export const settingsStore = createSettingsStore();
