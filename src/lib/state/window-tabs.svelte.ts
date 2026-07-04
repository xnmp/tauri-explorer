/**
 * Per-pane tabs state management.
 * Issues: tauri-explorer-ldfx (window tabs), #140 (dual-pane-as-windows)
 *
 * The window owns up to two panes (left/right); each pane owns its own
 * tab strip. Layout state (dual-pane enabled, split ratio, active pane)
 * is window-level. A tab is a single explorer — the second pane behaves
 * like another window docked to the side, with its own independent tabs.
 */

import type { PaneId, PaneTab, ExplorerTab, PaneTabs } from "./types";
import { createExplorerState, type ExplorerInstance } from "./explorer.svelte";
import { loadPersisted, savePersisted, removePersisted } from "./persisted";
import { parentDir, directoryKey, basename } from "$lib/domain/path";
import { disambiguateTabTitles } from "$lib/domain/tab-title";
import { settingsStore } from "./settings.svelte";
import { gitRepoRoot } from "$lib/api/files";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Tauri window label, or "main" outside Tauri (browser E2E, tests). */
function detectWindowLabel(): string {
  try {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      return getCurrentWindow().label || "main";
    }
  } catch {
    // Not running in Tauri
  }
  return "main";
}

const WINDOW_LABEL = detectWindowLabel();
// Namespace the tabs key per window so a child window doesn't clobber the
// main window's layout. The main window keeps the legacy un-suffixed key
// for backward compatibility with existing saved state.
const STORAGE_KEY = WINDOW_LABEL === "main" ? "explorer-tabs" : `explorer-tabs:${WINDOW_LABEL}`;
const CLOSED_TABS_KEY = "explorer-closed-tabs";

/** Serializable per-pane tab state for persistence (v2 shape). */
export interface PersistedPaneTab {
  id: string;
  path: string;
  /** Tab kind discriminator (#56). Absent in older saves — treated as "explorer". */
  kind?: "explorer" | "git-graph";
}

export interface PersistedPaneTabs {
  tabs: PersistedPaneTab[];
  activeTabId: string | null;
}

export interface PersistedTabState {
  version: 2;
  panes: {
    left: PersistedPaneTabs;
    right: PersistedPaneTabs;
  };
  activePaneId: PaneId;
  dualPaneEnabled: boolean;
  splitRatio: number;
}

/** Pre-inversion (v1) shape: window-level tabs each holding a left/right
 *  pane pair. Still read from localStorage and old saved workspaces. */
interface LegacyPersistedTab {
  id: string;
  panes: { left: { path: string }; right: { path: string } };
  activePaneId: PaneId;
  dualPaneEnabled: boolean;
  splitRatio: number;
}
interface LegacyPersistedTabState {
  tabs: LegacyPersistedTab[];
  activeTabId: string | null;
}

function isLegacyState(state: unknown): state is LegacyPersistedTabState {
  const s = state as LegacyPersistedTabState & { version?: number };
  return !!s && s.version === undefined && Array.isArray(s.tabs);
}

/** Map a v1 saved state onto per-pane tab lists: every tab's left pane
 *  becomes a left tab; right panes of dual-pane tabs become right tabs. */
export function migrateLegacyState(legacy: LegacyPersistedTabState): PersistedTabState {
  const tabs = Array.isArray(legacy.tabs) ? legacy.tabs : [];
  const leftTabs: PersistedPaneTab[] = tabs.map((t) => ({
    id: t.id,
    path: t.panes?.left?.path || "/home",
  }));
  const rightTabs: PersistedPaneTab[] = tabs
    .filter((t) => t.dualPaneEnabled && t.panes?.right?.path)
    .map((t) => ({ id: `${t.id}-right`, path: t.panes.right.path }));

  const active = tabs.find((t) => t.id === legacy.activeTabId) ?? tabs[0];
  const dualPaneEnabled = !!active?.dualPaneEnabled && rightTabs.length > 0;
  const activeRightId = active?.dualPaneEnabled
    ? `${active.id}-right`
    : (rightTabs[0]?.id ?? null);

  return {
    version: 2,
    panes: {
      left: {
        tabs: leftTabs,
        activeTabId: legacy.activeTabId ?? leftTabs[0]?.id ?? null,
      },
      right: {
        tabs: rightTabs,
        activeTabId: rightTabs.some((t) => t.id === activeRightId) ? activeRightId : (rightTabs[0]?.id ?? null),
      },
    },
    activePaneId: dualPaneEnabled && active?.activePaneId === "right" ? "right" : "left",
    dualPaneEnabled,
    splitRatio: typeof active?.splitRatio === "number" ? active.splitRatio : 0.5,
  };
}

/** Accept either persisted shape, migrating v1 on the fly. */
export function normalizePersistedState(state: unknown): PersistedTabState | null {
  if (!state) return null;
  if (isLegacyState(state)) return migrateLegacyState(state);
  const s = state as PersistedTabState;
  if (s.version === 2 && s.panes?.left && s.panes?.right) return s;
  return null;
}

/** Total tab count in a persisted state of either shape (workspace list UI). */
export function countPersistedTabs(state: unknown): number {
  const s = normalizePersistedState(state);
  if (!s) return 0;
  return s.panes.left.tabs.length + s.panes.right.tabs.length;
}

/** Serializable snapshot of a live tab, used for cross-window tab moves
 *  and tear-off into a new window. A tab is a single pane's view now, so
 *  the payload is just its path. */
export interface TabSnapshot {
  path: string;
}

/** Tolerate v1 snapshots ({leftPath, rightPath, activePaneId, ...}) that may
 *  linger in localStorage seeds written by a pre-inversion build. */
function normalizeSnapshot(raw: unknown): TabSnapshot | null {
  const s = raw as { path?: string; leftPath?: string; rightPath?: string; activePaneId?: PaneId };
  if (typeof s?.path === "string") return { path: s.path };
  if (typeof s?.leftPath === "string") {
    return { path: s.activePaneId === "right" && s.rightPath ? s.rightPath : s.leftPath };
  }
  return null;
}

/** localStorage key a freshly spawned tear-off window reads its tab from. */
export function tabSeedKey(windowLabel: string): string {
  return `tab-seed:${windowLabel}`;
}

/** Generate unique IDs for tabs and explorers */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Extract folder name from path for tab title */
export function extractFolderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path || "Explorer";
}

/** Snapshot of a closed tab for restoration via Ctrl+Shift+T */
interface ClosedTabSnapshot {
  path: string;
  paneId: PaneId;
  closedAt: number; // insertion index within its pane's strip
  fromClosedWindow: boolean; // true if this was the last tab when window closed
}

/** Tolerate v1 closed-tab snapshots persisted by a pre-inversion build. */
function normalizeClosedSnapshot(raw: unknown): ClosedTabSnapshot | null {
  const s = raw as ClosedTabSnapshot & { leftPath?: string; rightPath?: string; activePaneId?: PaneId };
  if (typeof s?.path === "string") return s;
  if (typeof s?.leftPath === "string") {
    return {
      path: s.activePaneId === "right" && s.rightPath ? s.rightPath : s.leftPath,
      paneId: "left",
      closedAt: s.closedAt ?? 0,
      fromClosedWindow: !!s.fromClosedWindow,
    };
  }
  return null;
}

const MAX_CLOSED_TABS = 20;

/** Result of restoring a closed tab */
export interface RestoreResult {
  restored: true;
  /** If the closed tab was from a closed window, the path to open in a new window */
  openInNewWindow?: string;
}

function loadClosedTabs(): ClosedTabSnapshot[] {
  return loadPersisted<unknown[]>(CLOSED_TABS_KEY, [])
    .map(normalizeClosedSnapshot)
    .filter((s): s is ClosedTabSnapshot => s !== null);
}

function emptyPane(): PaneTabs {
  return { tabs: [], activeTabId: null };
}

function createWindowTabsManager() {
  // Explorer instances registry (keyed by explorerId)
  const explorers = new Map<string, ExplorerInstance>();

  // Per-pane tab strips + window-level layout state
  let panes = $state<Record<PaneId, PaneTabs>>({ left: emptyPane(), right: emptyPane() });
  let activePaneId = $state<PaneId>("left");
  let dualPaneEnabled = $state(false);
  let splitRatio = $state(0.5);

  // Cache of folder → git repo root (string), or null when not in a repo.
  // Populated lazily by ensureGitRoot (driven from the tab bar) only while the
  // "git root in tab title" setting is on. Keyed by directoryKey(path).
  let gitRoots = $state(new Map<string, string | null>());
  const gitRootPending = new Set<string>();

  // Stack of recently closed tabs for Ctrl+Shift+T restoration (persisted)
  let closedTabStack: ClosedTabSnapshot[] = loadClosedTabs();

  /** Persist the closed tab stack to localStorage */
  function saveClosedTabs(): void {
    savePersisted(CLOSED_TABS_KEY, closedTabStack);
  }

  /** Reload the closed tab stack from localStorage (picks up cross-window changes) */
  function refreshClosedTabs(): void {
    closedTabStack = loadClosedTabs();
  }

  // Pick up snapshots written by other windows when this window regains
  // focus (instead of re-reading localStorage from the canRestoreTab getter).
  if (typeof window !== "undefined") {
    window.addEventListener("focus", refreshClosedTabs);
  }

  /** Destroy all registered explorers (unwatch dirs, drop listeners) and clear the registry. */
  function destroyAllExplorers(): void {
    for (const explorer of explorers.values()) {
      explorer.destroy();
    }
    explorers.clear();
  }

  /** Find which pane a tab lives in. */
  function paneOf(tabId: string): PaneId | null {
    if (panes.left.tabs.some((t) => t.id === tabId)) return "left";
    if (panes.right.tabs.some((t) => t.id === tabId)) return "right";
    return null;
  }

  function findTab(tabId: string): PaneTab | null {
    return (
      panes.left.tabs.find((t) => t.id === tabId) ??
      panes.right.tabs.find((t) => t.id === tabId) ??
      null
    );
  }

  /** All tabs across both panes (left first). */
  function allTabs(): PaneTab[] {
    return [...panes.left.tabs, ...panes.right.tabs];
  }

  /** Capture the current tab state as a serializable snapshot */
  function captureState(): PersistedTabState {
    const capturePane = (paneId: PaneId): PersistedPaneTabs => ({
      tabs: panes[paneId].tabs.map((t) => ({ id: t.id, path: getTabLivePath(t), kind: t.kind })),
      activeTabId: panes[paneId].activeTabId,
    });
    return {
      version: 2,
      panes: { left: capturePane("left"), right: capturePane("right") },
      activePaneId,
      dualPaneEnabled,
      splitRatio,
    };
  }

  /** Save current tab state to localStorage */
  function saveState(): void {
    savePersisted(STORAGE_KEY, captureState());
  }

  /** Load tab state from localStorage (migrating pre-inversion state) */
  function loadState(): PersistedTabState | null {
    return normalizePersistedState(loadPersisted<unknown>(STORAGE_KEY, null));
  }

  /** The active pane's active tab */
  const activeTab = $derived(
    panes[activePaneId].tabs.find((t) => t.id === panes[activePaneId].activeTabId) ?? null,
  );

  /** How a tab labels itself.
   *  - git mode (setting on + folder inside a repo): a git icon, the repo root
   *    name, and the current folder (`repo` is null when the cwd *is* the root).
   *  - normal mode: a folder icon and the (disambiguated) folder name. */
  interface TabDisplay {
    isGitRoot: boolean;
    repo: string | null;
    name: string;
  }

  /** Per-tab display info across both panes. Normal-mode tabs are
   *  disambiguated against each other (VS Code style); git-mode tabs carry
   *  repo + cwd, which is already distinct. Reactive on tab paths, the
   *  git-root cache, and the setting. */
  const tabDisplays = $derived.by((): Map<string, TabDisplay> => {
    const useGit = settingsStore.tabTitleGitRoot;
    const normal: { id: string; path: string }[] = [];
    const gitMode = new Map<string, { repoRoot: string; cwd: string }>();

    const tabs = allTabs().filter((t) => t.kind === "explorer");
    for (const t of tabs) {
      const cwd = getTabLivePath(t);
      const root = useGit ? gitRoots.get(directoryKey(cwd)) : null;
      if (root) gitMode.set(t.id, { repoRoot: root, cwd });
      else normal.push({ id: t.id, path: cwd });
    }

    const disamb = disambiguateTabTitles(normal);
    const out = new Map<string, TabDisplay>();
    for (const t of tabs) {
      const g = gitMode.get(t.id);
      if (g) {
        const atRoot = directoryKey(g.cwd) === directoryKey(g.repoRoot);
        out.set(t.id, {
          isGitRoot: true,
          repo: atRoot ? null : basename(g.repoRoot),
          name: atRoot ? basename(g.repoRoot) : basename(g.cwd),
        });
      } else {
        out.set(t.id, {
          isGitRoot: false,
          repo: null,
          name: disamb.get(t.id) ?? extractFolderName(getTabLivePath(t)),
        });
      }
    }
    return out;
  });

  /** Structured display (icon + repo + name) for rendering a tab. */
  function getTabDisplay(tab: PaneTab): TabDisplay {
    if (tab.kind !== "explorer") {
      return { isGitRoot: tab.kind === "git-graph", repo: null, name: tab.title };
    }
    return (
      tabDisplays.get(tab.id) ?? {
        isGitRoot: false,
        repo: null,
        name: extractFolderName(getTabLivePath(tab)),
      }
    );
  }

  /** Plain-text tab title (used for the drag ghost and width measurement). */
  function getTabTitle(tab: PaneTab): string {
    if (tab.kind !== "explorer") return tab.title;
    const explorer = explorers.get(tab.explorerId);
    if (!explorer) return tab.title || "Explorer";
    const d = getTabDisplay(tab);
    return d.repo ? `${d.repo} › ${d.name}` : d.name;
  }

  /** Fetch (and cache) the git repo root for a folder. No-op unless the
   *  setting is on and we haven't already resolved/queued this folder. Called
   *  from the tab bar so the async work has a component owner. */
  async function ensureGitRoot(path: string): Promise<void> {
    if (!settingsStore.tabTitleGitRoot || !path) return;
    const key = directoryKey(path);
    if (gitRoots.has(key) || gitRootPending.has(key)) return;
    gitRootPending.add(key);
    const result = await gitRepoRoot(path);
    gitRootPending.delete(key);
    const root = result.ok ? result.data : null;
    // Reassign for reactivity so tabDisplayTitles recomputes.
    gitRoots = new Map(gitRoots).set(key, root);
  }

  /** Live path for a tab: the explorer's current path, or the repo path
   *  for non-explorer kinds. */
  function getTabLivePath(tab: PaneTab): string {
    if (tab.kind !== "explorer") return tab.repoPath;
    const explorer = explorers.get(tab.explorerId);
    // || not ??: an explorer that hasn't completed its first navigation
    // reports "" — fall back to the tab's creation path, never persist "".
    return explorer?.state.currentPath || tab.path;
  }

  /** Get the directory path for any tab by ID (either pane). */
  function getTabPath(tabId: string): string | undefined {
    const tab = findTab(tabId);
    return tab ? getTabLivePath(tab) : undefined;
  }

  /** Get tooltip for a tab */
  function getTabTooltip(tab: PaneTab): string {
    return getTabLivePath(tab);
  }

  /** Create a new explorer and register it. If a source explorer is
   *  provided and shares the same path, seed the new one with its
   *  entries so the UI doesn't flash empty while loading. */
  function createAndRegisterExplorer(
    path: string,
    sourceExplorer?: ExplorerInstance,
    externalSeed?: { currentPath: string; entries: any[]; sortBy: string; sortAscending: boolean; viewMode: string },
    track = true,
  ): { explorerId: string; explorer: ExplorerInstance } {
    const explorerId = generateId("explorer");
    const canSeed = sourceExplorer && sourceExplorer.currentPath === path;
    const seed = canSeed
      ? {
          currentPath: sourceExplorer.currentPath,
          entries: [...sourceExplorer.displayEntries],
          sortBy: sourceExplorer.sortBy,
          sortAscending: sourceExplorer.sortAscending,
          viewMode: sourceExplorer.viewMode,
        }
      : externalSeed?.currentPath === path
        ? externalSeed as any
        : undefined;
    const explorer = createExplorerState(seed);
    explorers.set(explorerId, explorer);
    // Seeded/restored panes use a non-tracking initial load so restoring
    // tabs doesn't double-record frecency/recent-files visits.
    if (seed || !track) {
      explorer.initialLoad(path);
    } else {
      explorer.navigateTo(path);
    }
    return { explorerId, explorer };
  }

  /** Create a tab object with a new explorer */
  function createTabObject(path: string, sourceExplorer?: ExplorerInstance, externalSeed?: any, track = true): ExplorerTab {
    const { explorerId } = createAndRegisterExplorer(path, sourceExplorer, externalSeed, track);
    return {
      id: generateId("tab"),
      kind: "explorer",
      explorerId,
      path,
      title: extractFolderName(path),
    };
  }

  /** Create a new tab in the given pane and activate it (and the pane). */
  function createTabIn(paneId: PaneId, initialPath?: string, externalSeed?: any): PaneTab {
    const defaultPath = "/home";
    const pane = panes[paneId];
    const paneActiveTab = pane.tabs.find((t) => t.id === pane.activeTabId);

    // Inherit path and entries from the pane's active explorer so the new
    // tab renders instantly instead of flashing a loading state.
    const sourceExplorer =
      paneActiveTab?.kind === "explorer" ? explorers.get(paneActiveTab.explorerId) : undefined;
    const path = initialPath ?? (paneActiveTab ? getTabLivePath(paneActiveTab) : defaultPath);

    const tab = createTabObject(path, sourceExplorer, externalSeed);

    // Insert after the pane's active tab or at end
    const activeIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : pane.tabs.length;

    const newTabs = [...pane.tabs];
    newTabs.splice(insertIndex, 0, tab);
    panes = { ...panes, [paneId]: { tabs: newTabs, activeTabId: tab.id } };
    activePaneId = paneId;
    saveState();

    return tab;
  }

  /** Create a new tab in the active pane. */
  function createTab(initialPath?: string, externalSeed?: any): PaneTab {
    return createTabIn(activePaneId, initialPath, externalSeed);
  }

  /** Open a git-graph tab for `repoPath` in the active pane (#51/#56).
   *  Reuses an existing graph tab for the same repo instead of duplicating. */
  function openGitGraphTab(repoPath: string): PaneTab {
    const pane = panes[activePaneId];
    const existing = pane.tabs.find(
      (t) => t.kind === "git-graph" && t.repoPath === repoPath,
    );
    if (existing) {
      setActiveTab(existing.id);
      return existing;
    }
    const tab: PaneTab = {
      id: generateId("tab"),
      kind: "git-graph",
      repoPath,
      title: `Graph: ${extractFolderName(repoPath)}`,
    };
    const activeIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : pane.tabs.length;
    const newTabs = [...pane.tabs];
    newTabs.splice(insertIndex, 0, tab);
    panes = { ...panes, [activePaneId]: { tabs: newTabs, activeTabId: tab.id } };
    saveState();
    return tab;
  }

  /** Serialize a live tab for cross-window transfer / tear-off. */
  function exportTab(tabId: string): TabSnapshot | null {
    const tab = findTab(tabId);
    if (!tab) return null;
    return { path: getTabLivePath(tab) };
  }

  /** Adopt a tab transferred from another window: create a fresh explorer
   *  from the snapshot, insert at `index` (default: end) in `paneId`
   *  (default: active pane), and activate. */
  function adoptTab(snapshot: TabSnapshot, index?: number, paneId?: PaneId): PaneTab {
    const normalized = normalizeSnapshot(snapshot) ?? { path: "/home" };
    const targetPane: PaneId = paneId ?? (dualPaneEnabled ? activePaneId : "left");
    const tab = createTabObject(normalized.path);

    const pane = panes[targetPane];
    const at = index === undefined ? pane.tabs.length : Math.max(0, Math.min(index, pane.tabs.length));
    const newTabs = [...pane.tabs];
    newTabs.splice(at, 0, tab);
    panes = { ...panes, [targetPane]: { tabs: newTabs, activeTabId: tab.id } };
    activePaneId = targetPane;
    saveState();
    return tab;
  }

  /** Restore tabs from a persisted state (either shape; v1 is migrated).
   *  @param overridePath - If set, the active pane's active tab navigates
   *    here instead of its saved path (avoids racing navigations). */
  function restoreFromState(state: PersistedTabState | unknown, overridePath?: string): void {
    const normalized = normalizePersistedState(state);
    if (!normalized) return;

    // Destroy before clearing — otherwise backend watch refcounts and
    // streaming listeners leak for every replaced explorer.
    destroyAllExplorers();

    const restorePane = (paneId: PaneId): PaneTabs => {
      const persisted = normalized.panes[paneId];
      const tabs = persisted.tabs.map((pt): PaneTab => {
        if (pt.kind === "git-graph") {
          return {
            id: pt.id,
            kind: "git-graph",
            repoPath: pt.path,
            title: `Graph: ${extractFolderName(pt.path)}`,
          };
        }
        const isActiveTarget =
          paneId === normalized.activePaneId && pt.id === persisted.activeTabId && !!overridePath;
        const { explorerId } = createAndRegisterExplorer(
          isActiveTarget ? overridePath! : pt.path,
          undefined,
          undefined,
          false,
        );
        return {
          id: pt.id,
          kind: "explorer",
          explorerId,
          path: isActiveTarget ? overridePath! : pt.path,
          title: extractFolderName(pt.path),
        };
      });
      const activeTabId = tabs.some((t) => t.id === persisted.activeTabId)
        ? persisted.activeTabId
        : (tabs[0]?.id ?? null);
      return { tabs, activeTabId };
    };

    panes = { left: restorePane("left"), right: restorePane("right") };
    dualPaneEnabled = normalized.dualPaneEnabled && panes.right.tabs.length > 0;
    activePaneId = dualPaneEnabled && normalized.activePaneId === "right" ? "right" : "left";
    splitRatio = normalized.splitRatio;
  }

  /** Initialize - restores from localStorage or creates a new tab.
   *  @param skipRestore - When true, skip saved-state restoration and
   *    create a fresh tab at initialPath. Used for child windows spawned
   *    via Ctrl+N that receive their path via URL params.
   *  @param overridePath - When set, the active tab navigates here instead
   *    of its saved path. Used for CLI cwd so we don't race two navigations. */
  function init(initialPath: string, skipRestore = false, overridePath?: string): PaneTab {
    if (!skipRestore) {
      // Try to restore from localStorage (cold start / app relaunch)
      const savedState = loadState();
      if (savedState && savedState.panes.left.tabs.length > 0) {
        restoreFromState(savedState, overridePath);
        const pane = panes[activePaneId];
        const restored = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
        if (restored) return restored;
      }
    }

    // No saved state or child window — create a fresh tab
    destroyAllExplorers();
    panes = { left: emptyPane(), right: emptyPane() };
    activePaneId = "left";
    dualPaneEnabled = false;

    // Tear-off windows receive their tab through a label-keyed localStorage
    // seed written by the source window.
    const tabSeed = loadPersisted<{ snapshot: unknown; ts: number } | null>(
      tabSeedKey(WINDOW_LABEL),
      null,
    );
    if (tabSeed && Date.now() - tabSeed.ts < 10_000) {
      removePersisted(tabSeedKey(WINDOW_LABEL));
      const snapshot = normalizeSnapshot(tabSeed.snapshot);
      if (snapshot) return adoptTab(snapshot);
    }

    // Check for parent-window seed (child windows get entries pre-loaded)
    const targetPath = overridePath ?? initialPath;
    const seedKey = `dir-seed:${targetPath}`;
    const seed = loadPersisted<{ currentPath: string; entries: any[]; sortBy: string; sortAscending: boolean; viewMode: string; ts: number } | null>(seedKey, null);
    let externalSeed: any = undefined;
    if (seed && Date.now() - seed.ts < 5000) {
      externalSeed = seed;
      removePersisted(seedKey);
    }

    return createTab(targetPath, externalSeed);
  }

  /** Snapshot a tab for Ctrl+Shift+T restoration */
  function snapshotTab(tab: PaneTab, paneId: PaneId, tabIndex: number, fromClosedWindow = false): void {
    const snapshot: ClosedTabSnapshot = {
      path: getTabLivePath(tab),
      paneId,
      closedAt: tabIndex,
      fromClosedWindow,
    };

    // Closing the last tab snapshots then attempts window.close(), which can
    // fail silently — repeated Ctrl+W would stack identical snapshots.
    if (fromClosedWindow) {
      const top = closedTabStack[closedTabStack.length - 1];
      if (
        top &&
        top.fromClosedWindow &&
        top.path === snapshot.path &&
        top.paneId === snapshot.paneId &&
        top.closedAt === snapshot.closedAt
      ) {
        return;
      }
    }

    closedTabStack.push(snapshot);
    if (closedTabStack.length > MAX_CLOSED_TABS) {
      closedTabStack.shift();
    }
    saveClosedTabs();
  }

  /** Close a tab by ID. Closes the window if it's the last tab overall. */
  function closeTab(tabId: string): void {
    removeTab(tabId, { snapshot: true });
  }

  /** Remove a tab that moved to another window/pane. No Ctrl+Shift+T
   *  snapshot — the tab still lives, just elsewhere. Closes the window if
   *  it was the last tab. */
  function removeTransferredTab(tabId: string): void {
    removeTab(tabId, { snapshot: false });
  }

  function destroyTabExplorer(tab: PaneTab): void {
    if (tab.kind !== "explorer") return;
    const explorer = explorers.get(tab.explorerId);
    explorer?.destroy();
    explorers.delete(tab.explorerId);
  }

  function removeTab(tabId: string, opts: { snapshot: boolean }): void {
    const paneId = paneOf(tabId);
    if (!paneId) return;
    const pane = panes[paneId];
    const tabIndex = pane.tabs.findIndex((t) => t.id === tabId);
    const tab = pane.tabs[tabIndex];

    const isLastInPane = pane.tabs.length <= 1;
    const otherPaneId: PaneId = paneId === "left" ? "right" : "left";
    // Last tab overall = last in this pane and the other pane is empty too.
    const isLastOverall = isLastInPane && panes[otherPaneId].tabs.length === 0;

    // Snapshot before closing (even if it's the last tab)
    if (opts.snapshot) {
      snapshotTab(tab, paneId, tabIndex, isLastOverall);
    }

    if (isLastOverall) {
      // Close the window when closing the last tab
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch(() => {}); // Not in Tauri runtime
      return;
    }

    destroyTabExplorer(tab);

    if (isLastInPane) {
      // The pane collapses. If the LEFT pane emptied, the other pane's tabs
      // move into it so the window always has a populated left pane.
      const promoted = paneId === "left" ? panes[otherPaneId] : panes.left;
      panes = { left: promoted, right: emptyPane() };
      dualPaneEnabled = false;
      activePaneId = "left";
      saveState();
      return;
    }

    const newTabs = pane.tabs.filter((t) => t.id !== tabId);

    // Update active tab if closing the pane's active one
    let newActiveId = pane.activeTabId;
    if (pane.activeTabId === tabId) {
      const newIndex = Math.max(0, tabIndex - 1);
      newActiveId = newTabs[newIndex]?.id ?? null;
    }

    panes = { ...panes, [paneId]: { tabs: newTabs, activeTabId: newActiveId } };
    saveState();
  }

  /** Restore the most recently closed tab. Returns false if nothing to restore. */
  function restoreClosedTab(): false | RestoreResult {
    // Re-read from localStorage to pick up snapshots from other windows
    refreshClosedTabs();
    const snapshot = closedTabStack.pop();
    if (!snapshot) return false;
    saveClosedTabs();

    // If the tab was from a closed window, signal to open a new window instead
    if (snapshot.fromClosedWindow) {
      return { restored: true, openInNewWindow: snapshot.path };
    }

    // Restore into the pane it was closed from when that pane is visible;
    // otherwise into the left pane.
    const targetPane: PaneId =
      snapshot.paneId === "right" && !dualPaneEnabled ? "left" : snapshot.paneId;
    adoptTab({ path: snapshot.path }, Math.min(snapshot.closedAt, panes[targetPane].tabs.length), targetPane);
    return { restored: true };
  }

  /** Close the active pane's active tab */
  function closeActiveTab(): void {
    const id = panes[activePaneId].activeTabId;
    if (id) closeTab(id);
  }

  /** Set the active tab (in whichever pane it lives; focuses that pane) */
  function setActiveTab(tabId: string): void {
    const paneId = paneOf(tabId);
    if (!paneId) return;
    panes = { ...panes, [paneId]: { ...panes[paneId], activeTabId: tabId } };
    activePaneId = paneId;
    saveState();
  }

  /** Move to next tab in the active pane (wraps around) */
  function nextTab(): void {
    cycleTab(1);
  }

  /** Move to previous tab in the active pane (wraps around) */
  function prevTab(): void {
    cycleTab(-1);
  }

  function cycleTab(delta: number): void {
    const pane = panes[activePaneId];
    if (pane.tabs.length <= 1) return;
    const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    const nextIndex = (currentIndex + delta + pane.tabs.length) % pane.tabs.length;
    panes = { ...panes, [activePaneId]: { ...pane, activeTabId: pane.tabs[nextIndex].id } };
    saveState();
  }

  /** Get the explorer of a pane's active tab */
  function getExplorer(paneId: PaneId): ExplorerInstance | undefined {
    const pane = panes[paneId];
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
    return tab && tab.kind === "explorer" ? explorers.get(tab.explorerId) : undefined;
  }

  /** Iterate all known explorer instances across every pane and tab.
   *  Used by callers that need to broadcast a refresh to every pane that
   *  may currently be viewing an affected directory (e.g. cross-tab paste). */
  function getAllExplorers(): ExplorerInstance[] {
    return Array.from(explorers.values());
  }

  /** Get the active explorer (active pane's active tab) */
  function getActiveExplorer(): ExplorerInstance | undefined {
    return getExplorer(activePaneId);
  }

  /** Silently refresh the visible panes — for file operations (drops,
   *  pastes, external changes) that may affect either pane. The hidden
   *  right pane is skipped in single-pane mode (no wasted IPC);
   *  toggleDualPane refreshes it when it becomes visible again. */
  function refreshAllPanes(): void {
    getExplorer("left")?.refresh({ silent: true });
    if (dualPaneEnabled) {
      getExplorer("right")?.refresh({ silent: true });
    }
  }

  /** Set the active pane */
  function setActivePane(paneId: PaneId): void {
    if (activePaneId === paneId) return;
    if (paneId === "right" && !dualPaneEnabled) return;
    activePaneId = paneId;
    saveState();
  }

  /** Switch to the other pane */
  function switchPane(): void {
    if (!dualPaneEnabled) return;
    setActivePane(activePaneId === "left" ? "right" : "left");
  }

  /** Toggle dual pane mode: open/close the second pane. The right pane's
   *  tabs survive a close and reappear on reopen; a first open seeds one
   *  tab at the left pane's parent directory (a more useful default than
   *  mirroring the same folder). */
  function toggleDualPane(): void {
    if (dualPaneEnabled) {
      dualPaneEnabled = false;
      activePaneId = "left";
      saveState();
      return;
    }

    dualPaneEnabled = true;
    if (panes.right.tabs.length === 0) {
      const leftPath = getExplorer("left")?.state.currentPath || "/home";
      const parent = parentDir(leftPath);
      createTabIn("right", parent && parent !== leftPath ? parent : leftPath);
    } else {
      // The right pane received no refreshes while hidden — catch up.
      getExplorer("right")?.refresh({ silent: true });
      saveState();
    }
  }

  /** Set dual pane mode */
  function setDualPane(enabled: boolean): void {
    if (dualPaneEnabled === enabled) return;
    toggleDualPane();
  }

  /** Set split ratio (window-level) */
  function setSplitRatio(ratio: number): void {
    splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    saveState();
  }

  /** Reorder tabs within a pane's strip */
  function reorderTabs(paneId: PaneId, fromIndex: number, toIndex: number): void {
    const pane = panes[paneId];
    if (fromIndex < 0 || fromIndex >= pane.tabs.length) return;
    if (toIndex < 0 || toIndex >= pane.tabs.length) return;
    if (fromIndex === toIndex) return;

    const newTabs = [...pane.tabs];
    const [moved] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, moved);

    panes = { ...panes, [paneId]: { ...pane, tabs: newTabs } };
    saveState();
  }

  /** Move a live tab to the other pane's strip (same window — the explorer
   *  instance moves with it, no destroy/recreate). No-op when it's the
   *  pane's last tab: the source pane would collapse mid-drag. */
  function moveTabToPane(tabId: string, targetPaneId: PaneId, index?: number): void {
    const sourcePaneId = paneOf(tabId);
    if (!sourcePaneId || sourcePaneId === targetPaneId) return;
    const source = panes[sourcePaneId];
    if (source.tabs.length <= 1) return;

    const tab = source.tabs.find((t) => t.id === tabId)!;
    const sourceTabs = source.tabs.filter((t) => t.id !== tabId);
    let sourceActive = source.activeTabId;
    if (sourceActive === tabId) {
      const oldIndex = source.tabs.findIndex((t) => t.id === tabId);
      sourceActive = sourceTabs[Math.max(0, oldIndex - 1)]?.id ?? null;
    }

    const target = panes[targetPaneId];
    const at = index === undefined ? target.tabs.length : Math.max(0, Math.min(index, target.tabs.length));
    const targetTabs = [...target.tabs];
    targetTabs.splice(at, 0, tab);

    panes = {
      ...panes,
      [sourcePaneId]: { tabs: sourceTabs, activeTabId: sourceActive },
      [targetPaneId]: { tabs: targetTabs, activeTabId: tabId },
    } as Record<PaneId, PaneTabs>;
    activePaneId = targetPaneId;
    saveState();
  }

  return {
    // Pane state getters
    get panes() {
      return panes;
    },
    /** The active pane's tab strip (kept for command `when:` guards). */
    get tabs() {
      return panes[activePaneId].tabs;
    },
    get activeTabId() {
      return panes[activePaneId].activeTabId;
    },
    get activeTab() {
      return activeTab;
    },
    /** The active tab of a specific pane (for per-kind content dispatch). */
    paneActiveTab(paneId: PaneId): PaneTab | null {
      const pane = panes[paneId];
      return pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
    },
    /** Total tab count across both panes. */
    get totalTabCount() {
      return panes.left.tabs.length + panes.right.tabs.length;
    },

    // Window-level layout state
    get activePaneId() {
      return activePaneId;
    },
    get dualPaneEnabled() {
      return dualPaneEnabled;
    },
    get splitRatio() {
      return splitRatio;
    },

    // Tab operations
    init,
    createTab,
    createTabIn,
    openGitGraphTab,
    closeTab,
    closeActiveTab,
    exportTab,
    adoptTab,
    moveTabToPane,
    removeTransferredTab,
    get windowLabel() {
      return WINDOW_LABEL;
    },
    restoreClosedTab,
    get canRestoreTab() {
      // No side effects in the getter: the stack is refreshed on window
      // focus and explicitly before restore (restoreClosedTab).
      return closedTabStack.length > 0;
    },
    setActiveTab,
    nextTab,
    prevTab,
    reorderTabs,
    getTabTitle,
    getTabDisplay,
    getTabPath,
    getTabTooltip,
    ensureGitRoot,

    // Explorer access
    getExplorer,
    getActiveExplorer,
    getAllExplorers,
    refreshAllPanes,

    // Pane operations (window-level)
    setActivePane,
    switchPane,
    toggleDualPane,
    setDualPane,
    setSplitRatio,

    // Persistence
    save: saveState,
    captureState,
    restoreFromState,
  };
}

/** Factory for creating window tabs managers - exported for testing */
export { createWindowTabsManager };

export const windowTabsManager = createWindowTabsManager();
