/**
 * Settings state management using Svelte 5 runes.
 * Issue: tauri-explorer-npjh
 *
 * Stores UI preferences and hotkey customization.
 * Persisted to ~/.config/tauri-explorer/settings.json with
 * localStorage as synchronous fallback for immediate state.
 */

import { loadPersisted, savePersisted, writeConfigQueued } from "./persisted";
import { readConfigFile } from "$lib/api/files";
import type { ViewMode } from "./types";
import type { Command, CommandCategory } from "./commands.svelte";
import {
  type PreviewPanePositionMode,
  normalizePreviewPanePositionMode,
  cyclePreviewPanePositionMode,
  resolveEffectivePreviewPanePosition,
} from "$lib/domain/preview-pane-position";
import { windowSizeStore } from "./window-size.svelte";

/** Which navigation bar buttons to display */
export interface NavBarButtons {
  back: boolean;
  forward: boolean;
  up: boolean;
  refresh: boolean;
}

export type IconTheme = "default" | "material" | "minimal";

export type ThumbnailSize = "small" | "medium" | "large" | "xlarge";

/** Windows translucent system backdrop (Mica/Acrylic). "off" = opaque window. */
export type WindowsBackdrop = "off" | "mica" | "acrylic";

export interface ThumbnailSizeConfig {
  displaySize: number;
  genSize: number;
  quality: number;
  gridMinWidth: number;
}

export const THUMBNAIL_SIZE_CONFIG: Record<ThumbnailSize, ThumbnailSizeConfig> = {
  small:  { displaySize: 48,  genSize: 96,  quality: 75, gridMinWidth: 84  },
  medium: { displaySize: 64,  genSize: 128, quality: 80, gridMinWidth: 108 },
  large:  { displaySize: 96,  genSize: 192, quality: 85, gridMinWidth: 140 },
  xlarge: { displaySize: 128, genSize: 256, quality: 90, gridMinWidth: 172 },
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
  previewPaneWidth: number; // width in px when docked right, 0 = default (280px)
  previewPaneHeight: number; // height in px when docked top/bottom, 0 = default (240px)
  previewPanePosition: PreviewPanePositionMode; // preview pane dock edge: right (default), bottom, top, or auto (#467, picks the edge from window size)
  terminalPanelHeight: number; // embedded terminal panel height in px
  // Terminal line-editing shortcuts (#375): action id → binding string
  // ("Alt+Backspace"). Empty/missing = disabled (native key behavior).
  terminalShortcuts: Record<string, string>;
  theme: string; // active theme id, e.g. "dark", "golden-hour"
  premiumTheme: boolean; // opt-in "premium/aurora" surface treatment (accent-tinted hairlines, glow shadows, breadcrumb pills, translucent surfaces, static depth backdrop). Off = flatter/high-contrast look (#437)
  thumbnailSize: ThumbnailSize; // tile thumbnail size tier
  showGitStatus: boolean; // show git indicators on files
  recentItemsCount: number; // number of recent locations in sidebar (0 = hidden)
  millerLayers: number; // 0-3, number of ancestor columns in miller view
  millerLayersPreferred: number; // 1-3, remembered layer count for toggle
  millerHideEmpty: boolean; // hide folders containing no visible entries from miller columns
  showManuallyHidden: boolean; // reveal manually-hidden entries (dimmed)
  showScmPanel: boolean; // show SCM panel (independent of sidebar)
  enableTerminal: boolean; // feature flag: integrated terminal panel (Ctrl+`)
  enableGitGraph: boolean; // feature flag: git commit graph tab
  f5SyncsLocalBranches: boolean; // graph F5 also fetches + fast-forwards local branches behind their upstream (#432)
  scmTreeView: boolean; // group SCM file rows by folder hierarchy
  quickOpenDebug: boolean; // show score breakdown in QuickOpen results
  integratedTitleBar: boolean; // macOS: render tabs in title bar with overlay traffic lights
  macOsVibrancy: boolean; // macOS: native window vibrancy (translucent frosted glass), requires restart
  vibrancyBlur: boolean; // macOS: enable native blur behind vibrancy (off = theme background, no blur)
  floatingIslands: boolean; // island layout on any OS — panels float as rounded islands; composes with native macOS/Windows transparency, plain themed backdrop elsewhere (#277)
  windowsBackdrop: WindowsBackdrop; // Windows: translucent system backdrop (Mica/Acrylic), requires restart
  windowsBackdropOpacity: number; // Windows: acrylic tint opacity 0-100 (lower = more see-through)
  yaziNavigation: boolean; // left/right arrows navigate up/into folders in details/list view
  previewFontSize: number; // base font size (px) for text/code/markdown previews
  showPreviewInfo: boolean; // preview pane chrome: file name, type badge, size and modified rows (off = content only, #494)
  autoEnterSingleSubdir: boolean; // when entering a dir with exactly one visible subdir (and nothing else), descend into it recursively
  ffmpegPath: string; // explicit path to ffmpeg binary for video/audio thumbnails (empty = auto-detect)
  tabTitleGitRoot: boolean; // when the folder is inside a git repo, show the repo root name + git icon in the tab title (default on, #471)
  warmWindow: boolean; // keep a hidden pre-warmed window pooled so Ctrl+N is near-instant
  terminalFollowsExplorer: boolean; // auto-cd the embedded terminal when the active pane navigates (#149)
  explorerFollowsTerminal: boolean; // navigate the active pane when the terminal's shell changes cwd (OSC 7) (#149)
  pluginsEnabled: Record<string, boolean>; // per-plugin enable state (id → enabled); absent id falls back to the plugin's default (#142)
  defaultPaneLayout: PaneLayoutMode; // how the generic "New Pane" command splits (#228)
}

/** How the generic "New Pane" command places new panes (#228):
 *  dwindle = split the focused pane along its longer axis (Hyprland-style);
 *  right/down = always split that way. */
export type PaneLayoutMode = "dwindle" | "right" | "down";

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
  previewPaneHeight: 0,
  previewPanePosition: "right",
  terminalPanelHeight: 240,
  terminalShortcuts: {},
  theme: "light",
  premiumTheme: false,
  thumbnailSize: "small",
  showGitStatus: false,
  recentItemsCount: 6,
  millerLayers: 0,
  millerLayersPreferred: 2,
  millerHideEmpty: false,
  showManuallyHidden: false,
  showScmPanel: false,
  enableTerminal: true,
  enableGitGraph: true,
  f5SyncsLocalBranches: false,
  scmTreeView: false,
  quickOpenDebug: false,
  integratedTitleBar: false,
  macOsVibrancy: false,
  vibrancyBlur: true,
  floatingIslands: false,
  windowsBackdrop: "off",
  windowsBackdropOpacity: 65,
  yaziNavigation: true,
  previewFontSize: 12,
  showPreviewInfo: true,
  autoEnterSingleSubdir: false,
  ffmpegPath: "",
  tabTitleGitRoot: true,
  warmWindow: true,
  terminalFollowsExplorer: true,
  explorerFollowsTerminal: true,
  pluginsEnabled: {},
  defaultPaneLayout: "dwindle",
};

const STORAGE_KEY = "explorer-settings";
const CONFIG_FILENAME = "settings.json";

function loadSettings(): Settings {
  const saved = loadPersisted<Partial<Settings>>(STORAGE_KEY, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(settings: Settings): void {
  savePersisted(STORAGE_KEY, settings);
  writeConfigQueued(CONFIG_FILENAME, JSON.stringify(settings, null, 2));
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
      writeConfigQueued(CONFIG_FILENAME, JSON.stringify(settings, null, 2));
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
    get previewPaneHeight() {
      return settings.previewPaneHeight;
    },
    // Normalize on read so a malformed persisted value can never break layout.
    // This is the raw stored *mode* (may be "auto") — for the concrete edge
    // to actually render at, read `resolvedPreviewPanePosition` instead.
    get previewPanePosition() {
      return normalizePreviewPanePositionMode(settings.previewPanePosition);
    },
    // Concrete dock edge components render at: "auto" resolves via the
    // window's current size, everything else passes through unchanged.
    // A single derived seam so `+page.svelte`/`PreviewPane.svelte` never
    // have to think about "auto" themselves (#467).
    get resolvedPreviewPanePosition() {
      return resolveEffectivePreviewPanePosition(
        normalizePreviewPanePositionMode(settings.previewPanePosition),
        windowSizeStore.width,
        windowSizeStore.height,
      );
    },
    get terminalPanelHeight() {
      return settings.terminalPanelHeight;
    },
    get terminalShortcuts() {
      return settings.terminalShortcuts;
    },
    get theme() {
      return settings.theme;
    },
    get premiumTheme() {
      return settings.premiumTheme;
    },
    togglePremiumTheme(): void {
      update({ premiumTheme: !settings.premiumTheme });
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
    get enableTerminal() {
      return settings.enableTerminal;
    },
    toggleEnableTerminal(): void {
      update({ enableTerminal: !settings.enableTerminal });
    },
    get enableGitGraph() {
      return settings.enableGitGraph;
    },
    toggleEnableGitGraph(): void {
      update({ enableGitGraph: !settings.enableGitGraph });
    },
    // Global default new panes fall back to; per-pane visibility (#434) lives
    // on the pane node (see windowTabsManager.getPaneScmVisible).
    get f5SyncsLocalBranches() {
      return settings.f5SyncsLocalBranches;
    },
    toggleF5SyncsLocalBranches(): void {
      update({ f5SyncsLocalBranches: !settings.f5SyncsLocalBranches });
    },
    get showScmPanel() {
      return settings.showScmPanel;
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
    get integratedTitleBar() {
      return settings.integratedTitleBar;
    },
    get macOsVibrancy() {
      return settings.macOsVibrancy;
    },
    get vibrancyBlur() {
      return settings.vibrancyBlur;
    },
    get floatingIslands() {
      return settings.floatingIslands;
    },
    // ONE island-mode condition (#407, #434): macOS vibrancy, a Windows native
    // backdrop, and the platform-independent Floating Islands setting all drive
    // the same [data-vibrancy] island layout. Every island-layout decision
    // (miller-as-island hoist, in-pane suppression) must key off this single
    // derived, never off one platform's flag.
    get islandMode() {
      return (
        settings.macOsVibrancy ||
        settings.windowsBackdrop !== "off" ||
        settings.floatingIslands
      );
    },
    get windowsBackdrop() {
      return settings.windowsBackdrop;
    },
    setWindowsBackdrop(value: WindowsBackdrop): void {
      update({ windowsBackdrop: value });
    },
    get windowsBackdropOpacity() {
      return settings.windowsBackdropOpacity;
    },
    get yaziNavigation() {
      return settings.yaziNavigation;
    },
    get previewFontSize() {
      return settings.previewFontSize;
    },
    setPreviewFontSize(px: number): void {
      update({ previewFontSize: Math.max(8, Math.min(28, Math.round(px))) });
    },
    get autoEnterSingleSubdir() {
      return settings.autoEnterSingleSubdir;
    },
    get ffmpegPath() {
      return settings.ffmpegPath;
    },
    get defaultPaneLayout() {
      return settings.defaultPaneLayout;
    },
    setDefaultPaneLayout(mode: PaneLayoutMode): void {
      update({ defaultPaneLayout: mode });
    },
    get tabTitleGitRoot() {
      return settings.tabTitleGitRoot;
    },
    get warmWindow() {
      return settings.warmWindow;
    },
    get terminalFollowsExplorer() {
      return settings.terminalFollowsExplorer;
    },
    toggleTerminalFollowsExplorer(): void {
      update({ terminalFollowsExplorer: !settings.terminalFollowsExplorer });
    },
    get explorerFollowsTerminal() {
      return settings.explorerFollowsTerminal;
    },
    toggleExplorerFollowsTerminal(): void {
      update({ explorerFollowsTerminal: !settings.explorerFollowsTerminal });
    },
    get pluginsEnabled() {
      return settings.pluginsEnabled;
    },
    setPluginEnabled(id: string, enabled: boolean): void {
      update({ pluginsEnabled: { ...settings.pluginsEnabled, [id]: enabled } });
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
    setPreviewPaneHeight(px: number): void {
      update({ previewPaneHeight: Math.max(0, Math.min(600, px)) });
    },
    setPreviewPanePosition(position: string): void {
      update({ previewPanePosition: normalizePreviewPanePositionMode(position) });
    },
    cyclePreviewPanePosition(): void {
      update({ previewPanePosition: cyclePreviewPanePositionMode(settings.previewPanePosition) });
    },
    setTerminalPanelHeight(px: number): void {
      update({ terminalPanelHeight: Math.max(96, Math.min(800, Math.round(px))) });
    },
    /** Bind a terminal line-editing action (#375, #404). An empty string is
     *  STORED — it disables the action, masking any platform default; `null`
     *  removes the user entry so the platform default applies again. */
    setTerminalShortcut(actionId: string, binding: string | null): void {
      const next = { ...settings.terminalShortcuts };
      if (binding === null) delete next[actionId];
      else next[actionId] = binding.trim();
      update({ terminalShortcuts: next });
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

// --- Toggleable settings metadata for auto-registration in command palette ---

export interface ToggleSettingMeta {
  key: keyof Settings;
  id?: string;
  label: string;
  category?: CommandCategory;
  shortcut?: string;
  when?: () => boolean;
  handler?: () => void;
}

export const TOGGLE_SETTINGS: ToggleSettingMeta[] = [
  { key: "showSidebar", id: "view.toggleSidebar", label: "Toggle Sidebar" },
  { key: "showHidden", id: "view.toggleHidden", label: "Toggle Hidden Files", shortcut: "Ctrl+H" },
  { key: "showWindowControls", id: "view.toggleWindowControls", label: "Toggle Window Controls" },
  { key: "showAddressBar", id: "view.toggleAddressBar", label: "Toggle Address Bar", shortcut: "Alt+M D" },
  {
    key: "showPreviewPane",
    id: "view.togglePreviewPane",
    label: "Toggle Preview Pane",
    shortcut: "Space",
    when: () => {
      const active = document.activeElement;
      const tag = active?.tagName;
      return tag !== "INPUT" && tag !== "TEXTAREA" && !(active as HTMLElement)?.isContentEditable;
    },
  },
  { key: "showStatusBar", id: "view.toggleStatusBar", label: "Toggle Status Bar", shortcut: "Alt+M U" },
  { key: "showGitStatus", id: "view.toggleGitStatus", label: "Toggle Git Status Indicators" },
  { key: "millerHideEmpty", id: "view.toggleMillerHideEmpty", label: "Miller Columns: Toggle Hide Empty Folders" },
  { key: "showManuallyHidden", id: "view.toggleManuallyHidden", label: "Toggle Manually Hidden Files" },
  // SCM panel visibility is per-pane (#434); its toggle command lives in
  // view-commands.ts (acts on the active pane). The `showScmPanel` setting
  // remains as the default new panes fall back to.
  { key: "scmTreeView", id: "view.toggleScmTreeView", label: "Toggle SCM Tree View" },
  { key: "f5SyncsLocalBranches", id: "view.toggleF5SyncsLocalBranches", label: "Toggle Git Graph F5 Syncs Local Branches" },
  { key: "confirmDelete", id: "view.toggleConfirmDelete", label: "Toggle Confirm on Delete" },
  { key: "quickOpenDebug", id: "view.toggleQuickOpenDebug", label: "Toggle Quick Open Debug Scores" },
  { key: "yaziNavigation", label: "Toggle Yazi Navigation" },
  { key: "autoEnterSingleSubdir", label: "Toggle Auto-Enter Single Subfolder" },
  { key: "tabTitleGitRoot", label: "Toggle Git Repo Root in Tab Title" },
  { key: "integratedTitleBar", label: "Toggle Integrated Title Bar" },
  { key: "macOsVibrancy", label: "Toggle macOS Vibrancy" },
  { key: "vibrancyBlur", label: "Toggle Vibrancy Blur" },
  { key: "floatingIslands", label: "Toggle Floating Islands" },
  { key: "premiumTheme", label: "Toggle Premium Theme Effects" },
  { key: "terminalFollowsExplorer", label: "Toggle Terminal Follows Explorer" },
  { key: "explorerFollowsTerminal", label: "Toggle Explorer Follows Terminal" },
];

export function generateToggleCommands(): Command[] {
  return TOGGLE_SETTINGS.map((meta) => ({
    id: meta.id ?? `setting.toggle.${meta.key}`,
    label: meta.label,
    category: (meta.category ?? "view") as CommandCategory,
    shortcut: meta.shortcut,
    when: meta.when,
    toggleState: () => Boolean(settingsStore.state[meta.key]),
    handler:
      meta.handler ??
      (() => {
        settingsStore.update({ [meta.key]: !settingsStore.state[meta.key] });
      }),
  }));
}
