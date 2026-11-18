/**
 * Site demo: what a host page needs to build its controls from the real app
 * (colour/layout/icon themes, view modes, commands with their current
 * keybindings) and the app's panels with what genuinely controls each.
 * Read from the stores' public APIs; loaded only by the site-demo build.
 */
import { ICON_THEMES } from "$lib/domain/icon-theme-options";
import { BUILTIN_LAYOUT_CATALOG } from "$lib/domain/layout-theme";
import { getAllCommands } from "./commands.svelte";
import { keybindingsStore } from "./keybindings.svelte";
import { settingsStore } from "./settings.svelte";
import { terminalPanelStore } from "./terminal.svelte";
import { themeStore } from "./theme.svelte";
import { windowTabsManager } from "./window-tabs.svelte";

export type DemoPanelId =
  | "sidebar" | "address" | "status" | "preview" | "windowControls"
  | "terminal" | "split" | "miller" | "scm" | "git";

export interface DemoPanelInfo {
  id: DemoPanelId;
  name: string;
  /** The persisted setting that shows it, when it is a window-wide setting. */
  setting: string | null;
  /** The command that toggles it (bindable, runnable with `run`). */
  command: string;
  /** Where its visibility lives. */
  scope: "setting" | "window" | "pane";
  /** A setting that must be on for the panel to exist at all. */
  requires: string | null;
  note: string;
}

export const DEMO_PANELS: readonly DemoPanelInfo[] = [
  { id: "sidebar", name: "Sidebar", setting: "showSidebar", command: "view.toggleSidebar", scope: "setting", requires: null, note: "Quick Access, drives, Recycle Bin" },
  { id: "address", name: "Address bar", setting: "showAddressBar", command: "view.toggleAddressBar", scope: "setting", requires: null, note: "Navigation buttons and breadcrumbs" },
  { id: "status", name: "Status bar", setting: "showStatusBar", command: "view.toggleStatusBar", scope: "setting", requires: null, note: "" },
  { id: "preview", name: "Preview pane", setting: "showPreviewPane", command: "view.togglePreviewPane", scope: "setting", requires: null, note: "Dock edge: previewPanePosition" },
  { id: "windowControls", name: "Window controls", setting: "showWindowControls", command: "view.toggleWindowControls", scope: "setting", requires: null, note: "Minimise/maximise/close buttons in the title bar" },
  { id: "terminal", name: "Terminal", setting: null, command: "view.toggleTerminal", scope: "window", requires: "enableTerminal", note: "Runtime state, not persisted" },
  { id: "split", name: "Split", setting: null, command: "view.toggleDualPane", scope: "window", requires: null, note: "Splits the active tab; runtime state" },
  { id: "miller", name: "Miller columns", setting: "millerLayers", command: "view.toggleMillerColumns", scope: "pane", requires: null, note: "Per pane; the setting is the default for new panes" },
  { id: "scm", name: "Source control", setting: "showScmPanel", command: "view.toggleScmPanel", scope: "pane", requires: null, note: "Per pane; the setting is the default for new panes" },
  { id: "git", name: "Git graph", setting: null, command: "git.showGraph", scope: "pane", requires: "enableGitGraph", note: "Replaces the active pane's file view while open; needs a repository" },
];

export type DemoPanelState = Record<DemoPanelId, boolean>;

/** Every panel's current visibility (reactive when read inside an effect). */
export function demoPanelState(): DemoPanelState {
  const paneId = windowTabsManager.activePaneId;
  return {
    sidebar: settingsStore.showSidebar,
    address: settingsStore.showAddressBar,
    status: settingsStore.showStatusBar,
    preview: settingsStore.showPreviewPane,
    windowControls: settingsStore.showWindowControls,
    terminal: settingsStore.enableTerminal && terminalPanelStore.visible,
    split: windowTabsManager.dualPaneEnabled,
    miller: (windowTabsManager.getActiveExplorer()?.millerLayers ?? 0) > 0,
    scm: windowTabsManager.getPaneScmVisible(paneId),
    git: Boolean(windowTabsManager.getPaneGitGraph(paneId)),
  };
}

export interface DemoThemeColors {
  background: string;
  panel: string;
  text: string;
  muted: string;
  accent: string;
  folder: string;
}

const COLOR_TOKENS: Record<keyof DemoThemeColors, string> = {
  background: "--background-solid",
  panel: "--background-card",
  text: "--text-primary",
  muted: "--text-secondary",
  accent: "--accent",
  folder: "--icon-folder",
};

/** Resolve a theme's tokens on a detached probe carrying its `data-theme`. */
function themeColors(id: string): { dark: boolean; colors: DemoThemeColors } {
  const probe = document.createElement("div");
  probe.setAttribute("data-theme", id);
  probe.style.display = "none";
  document.body.appendChild(probe);
  try {
    const style = getComputedStyle(probe);
    const colors = Object.fromEntries(Object.entries(COLOR_TOKENS)
      .map(([key, token]) => [key, style.getPropertyValue(token).trim()])) as unknown as DemoThemeColors;
    return { dark: style.colorScheme.includes("dark"), colors };
  } finally {
    probe.remove();
  }
}

export function buildDemoCatalog() {
  return {
    themes: themeStore.availableThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      description: theme.description,
      ...themeColors(theme.id),
    })),
    layouts: BUILTIN_LAYOUT_CATALOG.themes.map(({ id, name, description, arrangement }) => ({ id, name, description, arrangement })),
    iconThemes: ICON_THEMES.map(({ id, name, description }) => ({ id, name, description })),
    viewModes: [
      { id: "details", command: "view.details" },
      { id: "list", command: "view.list" },
      { id: "tiles", command: "view.tiles" },
    ],
    commands: getAllCommands().map((command) => ({
      id: command.id,
      title: command.label,
      category: command.category,
      keybinding: keybindingsStore.getShortcut(command.id) ?? null,
      defaultKeybinding: command.shortcut ?? null,
      toggle: command.toggleState !== undefined,
      hidden: command.hidden === true,
    })),
    panels: DEMO_PANELS,
    customThemes: true,
  };
}
