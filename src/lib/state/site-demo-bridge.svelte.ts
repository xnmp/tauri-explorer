/**
 * Site demo: the host bridge (protocol in `domain/demo-protocol.ts`, host
 * documentation in `overhaul/bridge/README.md`). Host requests drive the real
 * stores and commands; app events are derived from the same stores, never
 * from the DOM, except the preview's fullscreen flag, which the preview
 * publishes on the document element as its public contract.
 *
 * Only same-origin messages from the embedding window are accepted, and
 * replies go to that origin only. Loaded only by the site-demo build.
 */
import { appMessage, buildCustomThemeCss, customThemeId, demoOpenKind, parseCustomTheme, parseHostMessage } from "$lib/domain/demo-protocol";
import type { DemoMedia } from "$lib/domain/demo-fixture";
import type { DemoBootReport } from "$lib/domain/demo-boot";
import { basename, parentDir } from "$lib/domain/path";
import { TRASH_PATH } from "$lib/domain/virtual-path";
import { getMockControl } from "$lib/api/mock-control";
import { mockFileContent, mockFiles } from "$lib/api/mock-fixtures";
import { mockTrashCount, mockWrittenFiles } from "$lib/api/mock-files";
import { onMockFsChange } from "$lib/api/mock-fs-changes";
import { getMockFixtureRepos } from "$lib/api/mock-git-fixture";
import type { MockWorldMedia } from "$lib/api/mock-world";
import { writeThemeFile } from "$lib/api/config";
import { executeCommand, getAllCommands } from "./commands.svelte";
import { dialogStore } from "./dialogs.svelte";
import { keybindingsStore } from "./keybindings.svelte";
import { settingsStore, type Settings } from "./settings.svelte";
import { terminalPanelStore } from "./terminal.svelte";
import { themeStore } from "./theme.svelte";
import { windowTabsManager } from "./window-tabs.svelte";
import { windowMaterial } from "./window-translucency.svelte";
import { buildDemoCatalog, DEMO_PANELS, demoPanelState, type DemoPanelId } from "./site-demo-catalog";

const VIEW_MODES = ["details", "list", "tiles"] as const;
type DemoViewMode = (typeof VIEW_MODES)[number];
const isViewMode = (value: unknown): value is DemoViewMode => VIEW_MODES.includes(value as DemoViewMode);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Proxies and class instances cannot cross postMessage; send plain JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function findEntry(path: string) {
  return mockFiles[parentDir(path)]?.find((entry) => entry.path === path);
}

function mediaUrls(item: DemoMedia | undefined): { src?: string; poster?: string } {
  if (!item) return {};
  if (item.kind !== "video") return { src: item.src };
  return { ...(item.src ? { src: item.src } : {}), ...(item.poster ? { poster: item.poster } : {}) };
}

/**
 * The row showing `path` in the shown tab's active pane, in this frame's
 * viewport coordinates; null when no such row is mounted (virtualized away,
 * or opened from somewhere else).
 */
function rowRect(path: string): { x: number; y: number; width: number; height: number } | null {
  const selector = `[data-path="${CSS.escape(path)}"]`;
  const rows = [
    ...document.querySelectorAll<HTMLElement>(`.pane-tree:not(.retained) .explorer-pane.active ${selector}`),
    ...document.querySelectorAll<HTMLElement>(`.pane-tree:not(.retained) ${selector}`),
  ];
  for (const row of rows) {
    const { x, y, width, height } = row.getBoundingClientRect();
    if (width > 0 && height > 0) return { x, y, width, height };
  }
  return null;
}

/** What the host needs to show `path` in its own viewer; null when it is no file. */
function openPayload(path: string, media: MockWorldMedia | null) {
  const entry = findEntry(path);
  if (!entry || entry.kind === "directory") return null;
  const text = mockWrittenFiles[path] ?? mockFileContent[path] ?? null;
  const item = media?.get(path);
  const name = basename(path);
  return {
    path,
    name,
    kind: demoOpenKind(name, { text, media: item, typeHint: media?.typeHint(path) }),
    ...(text !== null ? { text } : {}),
    ...mediaUrls(item),
    size: entry.size,
    date: entry.modified,
    rect: rowRect(path),
  };
}

function paneExplorers() {
  return windowTabsManager.activePaneIds.flatMap((paneId, index) => {
    const explorer = windowTabsManager.getExplorer(paneId);
    return explorer ? [{ paneId, index, explorer }] : [];
  });
}

function explorerFor(pane: unknown) {
  if (typeof pane === "number") return paneExplorers()[pane]?.explorer;
  if (typeof pane === "string") return windowTabsManager.getExplorer(pane);
  return windowTabsManager.getActiveExplorer();
}

async function navigate(path: unknown, pane: unknown): Promise<boolean> {
  if (typeof path !== "string" || !(path.startsWith("/") || path === TRASH_PATH)) return false;
  const explorer = explorerFor(pane);
  if (!explorer) return false;
  if (path === "/" || path === TRASH_PATH || mockFiles[path]) {
    await explorer.navigateTo(path);
    return explorer.currentPath === path;
  }
  if (!findEntry(path)) return false;
  await explorer.navigateTo(parentDir(path));
  return explorer.revealEntry(path);
}

async function setPanel(id: unknown, visible: unknown): Promise<boolean> {
  const panel = DEMO_PANELS.find((p) => p.id === id);
  if (!panel || typeof visible !== "boolean") return false;
  if (visible && panel.requires) settingsStore.update({ [panel.requires]: true } as Partial<Settings>);
  const current = () => demoPanelState()[panel.id as DemoPanelId];
  if (current() === visible) return true;
  switch (panel.id) {
    case "terminal":
      if (visible) terminalPanelStore.open(); else terminalPanelStore.close();
      break;
    case "split":
      windowTabsManager.setDualPane(visible);
      break;
    case "miller": {
      const explorer = windowTabsManager.getActiveExplorer();
      explorer?.setMillerLayers(visible ? Math.max(settingsStore.millerLayers, 2) : 0);
      break;
    }
    case "scm":
    case "git":
      await executeCommand(panel.command);
      break;
    default:
      settingsStore.update({ [panel.setting!]: visible } as Partial<Settings>);
  }
  return current() === visible;
}

const isFolder = (path: string) => path === "/" || Boolean(mockFiles[path]);

/**
 * Split on or off. `options.path` opens (or navigates) the second pane at a
 * folder, created there directly so it never shows another folder first;
 * `options.focus: false` leaves the first pane active.
 */
async function setSplit(on: unknown, options: unknown): Promise<boolean> {
  if (typeof on !== "boolean") return false;
  const { path, focus } = isRecord(options) ? options : {};
  if (path !== undefined && (typeof path !== "string" || !isFolder(path))) return false;
  if (!on || (path === undefined && focus !== false)) return setPanel("split", on);
  const first = windowTabsManager.activePaneId;
  if (!windowTabsManager.dualPaneEnabled) {
    if (path === undefined) await setPanel("split", true);
    else windowTabsManager.splitPane("right", path);
  } else if (path !== undefined && !(await navigate(path, 1))) {
    return false;
  }
  const second = windowTabsManager.activePaneIds[1];
  if (!second) return false;
  windowTabsManager.setActivePane(focus === false ? first : second);
  return true;
}

/** View mode is per pane: `pane` is an index or pane id (default: the active pane). */
function setViewMode(mode: unknown, pane: unknown): boolean {
  if (!isViewMode(mode)) return false;
  const explorer = explorerFor(pane);
  if (!explorer) return false;
  explorer.setViewMode(mode);
  return true;
}

function setSettings(partial: unknown) {
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) return plain(settingsStore.state);
  const { theme, ...rest } = partial as Record<string, unknown>;
  if (Object.keys(rest).length) settingsStore.update(rest as Partial<Settings>);
  if (typeof theme === "string" && themeStore.availableThemes.some((t) => t.id === theme)) themeStore.setTheme(theme);
  // These settings are only each new pane's default; make them visible now as well.
  if (typeof rest.millerLayers === "number") {
    for (const { explorer } of paneExplorers()) explorer.setMillerLayers(settingsStore.millerLayers);
  }
  if (isViewMode(rest.viewMode)) {
    for (const { explorer } of paneExplorers()) explorer.setViewMode(rest.viewMode);
  }
  return plain(settingsStore.state);
}

async function setCustomTheme(value: unknown): Promise<string | null> {
  const theme = parseCustomTheme(value);
  if (!theme) return null;
  const id = customThemeId(theme.name);
  const css = buildCustomThemeCss(id, theme);
  if (!css) return null;
  await writeThemeFile(`${id}.css`, css);
  await themeStore.initTheme();
  themeStore.setTheme(id);
  return id;
}

function snapshot(media: MockWorldMedia | null) {
  return plain({
    panes: paneExplorers().map(({ paneId, index, explorer }) => ({
      index, paneId, path: explorer.currentPath, viewMode: explorer.viewMode,
      selection: [...explorer.selectedPaths], active: paneId === windowTabsManager.activePaneId,
    })),
    path: windowTabsManager.getActiveExplorer()?.currentPath ?? null,
    settings: settingsStore.state,
    theme: themeStore.currentThemeId,
    panels: demoPanelState(),
    keybindings: userKeybindings(),
    overlay: false,
    media: media !== null,
    trashCount: mockTrashCount(),
    // Where the git graph has something to show (it needs a repository).
    repos: getMockFixtureRepos().map((repo) => ({ path: repo.root, branch: repo.branch, changes: repo.changes.length })),
    appearance: appearance(),
  });
}

/**
 * Give this frame keyboard focus (a host calls it after showing the demo
 * again). The element that held focus when the frame lost it gets it back;
 * when there is none, the active pane's selected row or file list does.
 */
function focusApp(): boolean {
  window.focus();
  const current = document.activeElement;
  if (!current || current === document.body) {
    const paneId = CSS.escape(windowTabsManager.activePaneId ?? "");
    const pane = document.querySelector<HTMLElement>(`.pane-tree:not(.retained) .explorer-pane[data-pane-id="${paneId}"]`);
    const target = [".file-list .entry-item.selected", ".file-list .entry-item[tabindex='0']", ".file-list .virtual-viewport"]
      .map((selector) => pane?.querySelector<HTMLElement>(selector)).find(Boolean) ?? pane;
    target?.focus({ preventScroll: true });
  }
  return document.hasFocus();
}

/**
 * What the frame element needs from its host: the material behind the app
 * (Translucency) and the document's color scheme. A browser paints an opaque
 * backdrop behind a frame whose color scheme differs from its element's, so
 * a transparent app shows the host page only while the two agree; TXBridge
 * sets the element's `color-scheme` from this.
 */
function appearance() {
  void themeStore.appliedThemeRevision; // re-read after every applied theme
  return {
    colorScheme: getComputedStyle(document.documentElement).colorScheme || "normal",
    material: windowMaterial(),
  };
}

function userKeybindings(): Record<string, string | null> {
  return Object.fromEntries(keybindingsStore.getAllBindings()
    .filter((b) => b.userShortcut !== null || keybindingsStore.hasCustomShortcut(b.commandId))
    .map((b) => [b.commandId, keybindingsStore.getShortcut(b.commandId) ?? null]));
}

export interface SiteDemoBridgeOptions {
  host: Window;
  origin: string;
  media: MockWorldMedia | null;
  /** How the boot went: sent with `ready` so a host learns why its fixture is not served. */
  boot: DemoBootReport;
}

/** Answer host requests and publish app events until the page unloads. */
export function startSiteDemoBridge({ host, origin, media, boot }: SiteDemoBridgeOptions): void {
  const post = (type: "event" | "response", body: Record<string, unknown>) => host.postMessage(appMessage(type, body), origin);
  const emit = (event: string, data: unknown) => post("event", { event, data: plain(data) });

  const handlers: Record<string, (...params: unknown[]) => unknown> = {
    getState: () => snapshot(media),
    getCatalog: () => plain(buildDemoCatalog()),
    setSettings,
    setKeybinding: (id, keys) => {
      if (typeof id !== "string" || !(typeof keys === "string" || keys === null)) return false;
      keybindingsStore.setShortcut(id, keys);
      return true;
    },
    resetKeybinding: (id) => { if (typeof id === "string") keybindingsStore.resetToDefault(id); return true; },
    resetKeybindings: () => { keybindingsStore.resetAllToDefaults(); return true; },
    run: (id) => (typeof id === "string" && getAllCommands().some((c) => c.id === id) ? executeCommand(id) : false),
    navigate,
    setPanel,
    setSplit,
    setViewMode,
    setTerminalOpen: (on) => setPanel("terminal", on),
    playVideo: async (path) => {
      if (typeof path !== "string" || media?.get(path)?.kind !== "video") return false;
      settingsStore.update({ showPreviewPane: true });
      return navigate(path, undefined);
    },
    readFile: (path) => (typeof path === "string" ? openPayload(path, media) : null),
    setCustomTheme,
    focusApp,
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== host || event.origin !== origin) return;
    const message = parseHostMessage(event.data);
    if (message?.type !== "request") return;
    const handler = handlers[message.method];
    if (!handler) {
      post("response", { id: message.id, ok: false, error: `Unknown method: ${message.method}` });
      return;
    }
    try {
      post("response", { id: message.id, ok: true, result: plain((await handler(...message.params)) ?? null) });
    } catch (error) {
      post("response", { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const control = getMockControl();
  control.openFile = (path) => {
    const payload = openPayload(path, media);
    if (payload) emit("open-external", payload);
  };
  // The title bar's window buttons: the host decides what a window does.
  control.windowControl = (action) => emit("window-control", { action });
  // Every executed change, including undo/redo, publishes to this feed.
  onMockFsChange((change) => emit("fs-change", { ...change, trashCount: mockTrashCount() }));

  let fullscreen = $state(document.documentElement.hasAttribute("data-preview-fullscreen"));
  new MutationObserver(() => { fullscreen = document.documentElement.hasAttribute("data-preview-fullscreen"); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-preview-fullscreen"] });

  const ready = $derived.by(() => {
    const explorer = windowTabsManager.getActiveExplorer();
    return Boolean(explorer?.currentPath) && !explorer!.awaitingFirstListing
      && getAllCommands().length > 0 && themeStore.availableThemes.length > 0;
  });

  /** Emit `event` whenever `read` changes after the app is ready (not for the initial value). */
  const watch = (event: string, read: () => unknown, publish: (value: unknown) => unknown = (value) => value) => {
    let last: string | undefined;
    $effect(() => {
      if (!ready) return;
      const value = read();
      const key = JSON.stringify(value);
      if (last !== undefined && key !== last) emit(event, publish(value));
      last = key;
    });
  };

  $effect.root(() => {
    // From boot, not only after ready: a transparent frame needs its color
    // scheme matched before its first translucent paint.
    let lastAppearance = "";
    $effect(() => {
      const value = appearance();
      const key = JSON.stringify(value);
      if (key !== lastAppearance) emit("appearance", value);
      lastAppearance = key;
    });
    let announced = false;
    $effect(() => {
      if (!ready || announced) return;
      announced = true;
      emit("ready", { catalog: buildDemoCatalog(), state: snapshot(media), boot });
    });
    watch("settings", () => settingsStore.state);
    watch("keybindings", userKeybindings);
    watch("panels", demoPanelState);
    watch("overlay", () => ({ open: fullscreen || dialogStore.hasModalOpen, fullscreen, modal: dialogStore.hasModalOpen }));
    for (const slot of [0, 1]) {
      // A new pane has no path ("") until its first navigation: report only real paths.
      watch("navigate", () => paneExplorers()[slot]?.explorer.currentPath || null, (path) => ({ path, pane: slot }));
      watch("view", () => paneExplorers()[slot]?.explorer.viewMode ?? null, (viewMode) => ({ viewMode, pane: slot }));
    }
    watch("select", () => {
      const explorer = windowTabsManager.getActiveExplorer();
      const paths = explorer ? [...explorer.selectedPaths] : [];
      return { path: paths.at(-1) ?? null, paths };
    });
  });
}
