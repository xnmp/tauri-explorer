/**
 * Window tabs state management.
 * Issues: tauri-explorer-ldfx (window tabs), #228 (pane layout trees)
 *
 * The window owns a single tab strip. Each explorer tab owns a pane layout
 * tree (binary splits, ghostty-style): leaves are panes, each backed by its
 * own explorer instance. Dual pane is just the two-pane special case;
 * arbitrary splits (up/down/left/right, dwindle) are first-class. Tabs with
 * two or more panes can be renamed; renaming also saves the layout as a
 * workspace.
 */

import { SvelteMap } from "svelte/reactivity";
import { createWindowClose, type NativeCloseSource } from "./window-close";
import { createPaneActivationQueue, type PaneActivationScheduler } from "./pane-activation";
import type { PaneId, WindowTab, ExplorerTab, TabPane } from "./types";
import {
  type PaneNode,
  type SplitPlacement,
  type FocusDirection,
  leaf,
  leafIds,
  leafInDirection,
  countLeaves,
  splitLeaf,
  splitNode,
  hasNode,
  findNode,
  removeLeaf,
  updateRatio,
  dwindlePlacement,
  leafSiblingContext,
} from "$lib/domain/pane-layout";
import { createExplorerState, type ExplorerInstance } from "./explorer.svelte";
import { createPaneSessions } from "./pane-sessions";
import {
  createCoalescedPersister,
  loadPersisted,
  removePersisted,
} from "./persisted";
import { parentDir } from "$lib/domain/path";
import { acknowledgeWindowHandoff } from "./window-handoff";
import { isFreshSeed, isRecord, normalizeDirectorySeed, windowSeedFitsBudget, WINDOW_SEED_MAX_CHARS, type ExplorerSeed } from "$lib/domain/window-input";
import { createTabDisplay } from "./tab-display.svelte";
import { settingsStore } from "./settings.svelte";
import { workspacesStore } from "./workspaces.svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type PersistedNode,
  type PersistedWindowTab,
  type PersistedTabState,
  type LegacyPersistedTabState,
  isLegacyState,
  migrateLegacyState,
  migrateV2State,
  normalizePersistedState,
  countPersistedTabs,
  type TabSnapshot,
  normalizeSnapshot,
  tabSeedKey,
  directorySeedKey,
  type ClosedTabSnapshot,
  normalizeClosedSnapshot,
  type RestoreResult,
} from "./window-tabs-persistence";
import { createClosedTabsStore } from "./closed-tabs";
import { disposeScmStore } from "./scm.svelte";
import { disposeCommitPanelStore } from "./commit-panel.svelte";
import { dropGraphFileHistory } from "./git-graph-file-history";

// Re-export persistence & migration helpers so existing importers of this
// module keep working after the extraction (refactor/audit-tier4-splits #212).
export {
  isLegacyState,
  migrateLegacyState,
  migrateV2State,
  normalizePersistedState,
  countPersistedTabs,
  normalizeSnapshot,
  tabSeedKey,
  directorySeedKey,
  normalizeClosedSnapshot,
};
export type {
  PersistedNode,
  PersistedWindowTab,
  PersistedTabState,
  LegacyPersistedTabState,
  TabSnapshot,
  ClosedTabSnapshot,
  RestoreResult,
};

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

/** Generate unique IDs for tabs, panes, and splits */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Re-exported for existing importers/tests; canonical home is domain (#281).
export { extractFolderName } from "$lib/domain/tab-title";

type ExternalSeed = ExplorerSeed;

// A tab's persisted ID can be reused on restore; this identity cannot. Symbol
// values survive immutable tab updates and never enter persisted snapshots.
const TAB_INSTANCE = Symbol("tab instance");
type ManagedTab = WindowTab & { readonly [TAB_INSTANCE]: symbol };
export interface TabTransfer {
  /** Each reader receives an isolated copy of the captured transfer payload. */
  readonly snapshot: TabSnapshot;
  /** Call only after destination adoption; stale or repeated completion is inert. */
  complete(): boolean;
  /** Release an unadopted transfer before allowing a replacement. */
  cancel(): void;
}


type TestManagerRegistry = Set<{ dispose(): Promise<void> }>;

function testManagerRegistry(): TestManagerRegistry | undefined {
  return (globalThis as typeof globalThis & {
    __tauriExplorerTestManagerRegistry?: TestManagerRegistry;
  }).__tauriExplorerTestManagerRegistry;
}

function createWindowTabsManager(options: {
  schedulePaneActivation?: PaneActivationScheduler;
  nativeWindow?: () => NativeCloseSource;
} = {}) {
  const paneReadiness = new SvelteMap<PaneId, boolean>();
  const sessions = createPaneSessions<ExplorerInstance>({
    onChange(paneId, ready) {
      if (ready === undefined) paneReadiness.delete(paneId);
      else paneReadiness.set(paneId, ready);
    },
    releasePane(paneId) {
      disposeCommitPanelStore(paneId);
      dropGraphFileHistory(paneId);
      return disposeScmStore(paneId);
    },
    reportCleanupError(reason, error) {
      console.error(reason === "replaced"
        ? "Failed to clean up previous explorers:"
        : "Failed to clean up removed explorer:", error);
    },
  });
  const paneActivation = createPaneActivationQueue({
    isPending: sessions.isPending,
    activate: (paneId) => { sessions.activate(paneId); },
    schedule: options.schedulePaneActivation,
  });
  let disposal: Promise<void> | null = null;
  // Once native close is dispatched it cannot be recalled. Reject incoming
  // ownership until it fails; otherwise a newly adopted tab could be lost.
  let closing = false;
  const transfers = new Set<symbol>();
  function requireOpenWindow(): void {
    if (closing || disposal) throw new Error("Window is closing");
  }
  const windowClose = createWindowClose({
    source: options.nativeWindow ?? getCurrentWindow,
    begin: () => {
      if (closing || disposal) return null;
      closing = true;
      paneActivation.cancel();
      return () => {
        if (disposal) return;
        closing = false;
        activateTabResources(activeTabId);
      };
    },
    save: () => saveStateNow(),
    reportError: (error) => console.error("Could not close window:", error),
  });

  // Window-level tab strip
  let tabs = $state<ManagedTab[]>([]);
  let activeTabId = $state<string | null>(null);

  // Stack of recently closed tabs for Ctrl+Shift+T restoration (persisted)
  const closedTabs = createClosedTabsStore();

  // Stack of recently closed PANES (#229): Ctrl+Shift+T restores the last
  // closed surface, ghostty-style — a pane back into its split position, or
  // the last closed tab when that's more recent. In-memory: a pane snapshot
  // is only meaningful while its tab still lives in this window.
  interface ClosedPaneSnapshot {
    tabId: string;
    path: string;
    /** Node the pane was split against (leaf or subtree), with placement/ratio. */
    siblingId: string;
    placement: SplitPlacement;
    ratio: number;
    ts: number;
  }
  const MAX_CLOSED_PANES = 20;
  let closedPanes: ClosedPaneSnapshot[] = [];

  // Pick up snapshots written by other windows when this window regains
  // focus (instead of re-reading localStorage from the canRestoreTab getter).
  // Named (not inline) so dispose() can remove it — an inline arrow is
  // unremovable and leaks the whole manager closure per factory call (#439).
  const onWindowFocus = () => closedTabs.refresh();
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onWindowFocus);
  }

  const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? null);

  /** The active tab's focused pane id ("" for non-explorer tabs). */
  const activePaneId = $derived(
    activeTab?.kind === "explorer" ? activeTab.activePaneId : "",
  );

  /** Pane ids of the active tab, in visual order. */
  const activePaneIds = $derived(
    activeTab?.kind === "explorer" ? leafIds(activeTab.layout) : [],
  );

  function findTab(tabId: string): ManagedTab | null {
    return tabs.find((t) => t.id === tabId) ?? null;
  }

  /** Live path of one pane of an explorer tab. */
  function panePath(tab: ExplorerTab, paneId: PaneId): string {
    const pane = tab.panes[paneId];
    if (!pane) return "/home";
    // || not ??: an explorer that hasn't completed its first navigation
    // reports "" — fall back to the pane's creation path, never persist "".
    return sessions.get(paneId)?.state.currentPath || pane.path;
  }

  /** Live path for a tab: its active pane's path. */
  function getTabLivePath(tab: WindowTab): string {
    return panePath(tab, tab.activePaneId);
  }

  /** Serialize one live tab (paths read from the live explorers). */
  function persistTab(tab: WindowTab): PersistedWindowTab {
    const toPersisted = (node: PaneNode): PersistedNode =>
      node.type === "leaf"
        ? {
            type: "leaf",
            id: node.id,
            path: panePath(tab, node.id),
            ...(tab.panes[node.id]?.gitGraph ? { gitGraph: tab.panes[node.id].gitGraph } : {}),
          }
        : {
            type: "split",
            id: node.id,
            direction: node.direction,
            ratio: node.ratio,
            first: toPersisted(node.first),
            second: toPersisted(node.second),
          };
    return {
      id: tab.id,
      kind: "explorer",
      layout: toPersisted(tab.layout),
      activePaneId: tab.activePaneId,
      ...(tab.name ? { name: tab.name } : {}),
    };
  }

  /** Capture the current tab state as a serializable snapshot */
  function captureState(): PersistedTabState {
    return { version: 3, tabs: tabs.map(persistTab), activeTabId };
  }

  /** Tab-state writes are coalesced onto a trailing timer (#481): saveState
   *  runs on every tab open/close/switch/rename/split/pane-focus, and under
   *  WebKitGTK each localStorage write can stall the UI thread for a disk
   *  flush. Every write but the last of a burst is redundant, so hold them
   *  until the user pauses — 150ms is long enough to swallow a burst of
   *  Ctrl+T/Ctrl+Tab and short enough that state is durable a beat later. */
  const SAVE_COALESCE_MS = 150;
  const tabStatePersister = createCoalescedPersister<PersistedTabState>(
    STORAGE_KEY,
    SAVE_COALESCE_MS,
  );

  /** Queue the current tab state for persistence. Coalesced — see above; the
   *  write lands shortly after the last of a burst of interactions, or
   *  immediately if the page is hidden/unloaded before then. */
  function saveState(): void {
    tabStatePersister.schedule(captureState());
  }

  /** Persist the current tab state right now, superseding any queued write.
   *  For callers whose whole job is durability — the `beforeunload` handler
   *  and the periodic safety save in use-window-lifecycle — which must not
   *  hand back control before the state is stored. */
  function saveStateNow(): void {
    tabStatePersister.writeNow(captureState());
  }

  /** Load tab state from localStorage (migrating older shapes) */
  function loadState(): PersistedTabState | null {
    return normalizePersistedState(loadPersisted<unknown>(STORAGE_KEY, null, WINDOW_SEED_MAX_CHARS));
  }

  // Tab labels/titles + git-root decoration live in their own module (#281);
  // it reads tabs/paths through these getters so reactivity is unchanged.
  const tabDisplay = createTabDisplay({
    getTabs: () => tabs,
    getTabLivePath,
    panePath,
  });
  const { getTabDisplay, getTabTitle, ensureGitRoot, getGitRoot } = tabDisplay;

  /** Get the directory path for any tab by ID (its active pane). */
  function getTabPath(tabId: string): string | undefined {
    const tab = findTab(tabId);
    return tab ? getTabLivePath(tab) : undefined;
  }

  /** Live path of a pane by ID (searched across all tabs), with the pane's
   *  creation path as fallback while its explorer is still loading. */
  function getPanePath(paneId: PaneId): string | undefined {
    for (const tab of tabs) {
      if (tab.kind === "explorer" && tab.panes[paneId]) return panePath(tab, paneId);
    }
    return undefined;
  }

  /** Get tooltip for a tab: every pane's path. */
  function getTabTooltip(tab: WindowTab): string {
    return leafIds(tab.layout)
      .map((paneId) => panePath(tab, paneId))
      .join("\n");
  }

  /** Create a new explorer and register it. If a source explorer is
   *  provided and shares the same path, seed the new one with its
   *  entries so the UI doesn't flash empty while loading. */
  function createAndRegisterExplorer(
    paneId: PaneId,
    path: string,
    sourceExplorer?: ExplorerInstance,
    externalSeed?: ExternalSeed,
    track = true,
  ): void {
    requireOpenWindow();
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
        ? externalSeed
        : undefined;
    // Seeded/restored panes must not record duplicate visits.
    sessions.create(paneId, () => createExplorerState(seed), async (explorer) => {
      await (seed || !track ? explorer.initialLoad(path) : explorer.navigateTo(path));
    });
  }

  /** Create a single-pane explorer tab object (not yet inserted). */
  function createTabObject(
    path: string,
    sourceExplorer?: ExplorerInstance,
    externalSeed?: ExternalSeed,
    track = true,
  ): ManagedTab {
    const paneId = generateId("pane");
    createAndRegisterExplorer(paneId, path, sourceExplorer, externalSeed, track);
    return {
      [TAB_INSTANCE]: Symbol(),
      id: generateId("tab"),
      kind: "explorer",
      layout: leaf(paneId),
      panes: { [paneId]: { path } },
      activePaneId: paneId,
    };
  }

  /** Insert a tab after the active one and activate it. */
  function insertTab(tab: ManagedTab, index?: number): void {
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
    const at =
      index !== undefined
        ? Math.max(0, Math.min(index, tabs.length))
        : activeIndex >= 0
          ? activeIndex + 1
          : tabs.length;
    const newTabs = [...tabs];
    newTabs.splice(at, 0, tab);
    tabs = newTabs;
    activeTabId = tab.id;
    activateTabResources(tab.id);
    saveState();
  }

  /** Create a new tab and activate it. */
  function createTab(initialPath?: string, externalSeed?: ExternalSeed): WindowTab {
    const defaultPath = "/home";
    // Inherit path and entries from the active pane's explorer so the new
    // tab renders instantly instead of flashing a loading state.
    const sourceExplorer = getActiveExplorer();
    const path = initialPath ?? (activeTab ? getTabLivePath(activeTab) : defaultPath);
    const tab = createTabObject(path, sourceExplorer, externalSeed);
    insertTab(tab);
    return tab;
  }

  /** The repo whose commit graph a pane is showing, if any (#272). */
  function getPaneGitGraph(paneId: PaneId): string | undefined {
    for (const tab of tabs) {
      if (tab.panes[paneId]) return tab.panes[paneId].gitGraph;
    }
    return undefined;
  }

  /** Point a pane's open commit graph at a different repo, or close it
   *  (null). Used when the pane's directory changes while the graph is
   *  showing — the graph follows the navigation instead of pinning the old
   *  repo (#362). No-op when the pane isn't showing a graph. */
  function setPaneGitGraph(paneId: PaneId, repoPath: string | null): void {
    for (const tab of tabs) {
      const pane = tab.panes[paneId];
      if (!pane) continue;
      if (!pane.gitGraph) return;
      if (repoPath) pane.gitGraph = repoPath;
      else delete pane.gitGraph;
      saveState();
      return;
    }
  }

  /** Show the graph for one specific pane. Unlike the active-pane toggle,
   *  this is idempotent so SCM row actions can safely target their owner. */
  function showGitGraphInPane(paneId: PaneId, repoPath: string): void {
    for (const tab of tabs) {
      const pane = tab.panes[paneId];
      if (!pane) continue;
      pane.gitGraph = repoPath;
      saveState();
      return;
    }
  }

  /** Toggle the commit graph in the active pane (#272): showing → back to
   *  the file listing; hidden → the graph for `repoPath`. */
  function toggleGitGraphInActivePane(repoPath: string | null): void {
    const tab = activeTab;
    const pane = tab?.panes[tab.activePaneId];
    if (!tab || !pane) return;
    if (pane.gitGraph) {
      delete pane.gitGraph;
    } else if (repoPath) {
      pane.gitGraph = repoPath;
    }
    saveState();
  }

  /** Whether a pane's SCM panel is visible (#434). Per-pane override wins;
   *  when the pane made no explicit choice, fall back to the global
   *  `showScmPanel` setting so new panes and existing tests track the default. */
  function getPaneScmVisible(paneId: PaneId): boolean {
    for (const tab of tabs) {
      const pane = tab.panes[paneId];
      if (pane) return pane.scmPanel ?? settingsStore.showScmPanel;
    }
    return settingsStore.showScmPanel;
  }

  /** Toggle the SCM panel in the active pane only (#434). Sets an explicit
   *  per-pane override so sibling panes are unaffected. */
  function toggleScmInActivePane(): boolean {
    const tab = activeTab;
    const pane = tab?.panes[tab.activePaneId];
    if (!tab || !pane) return false;
    const next = !(pane.scmPanel ?? settingsStore.showScmPanel);
    pane.scmPanel = next;
    saveState();
    return next;
  }

  /** Rebuild tab descriptors, reserving explorers until the tab is activated.
   *  `regenerateIds` gives the tab and its panes fresh ids (adopting
   *  into a window that may already contain the original ids). */
  function reviveTab(
    persisted: PersistedWindowTab,
    opts: { regenerateIds?: boolean; overridePath?: string } = {},
  ): ManagedTab {
    requireOpenWindow();
    const idMap = new Map<string, string>();
    const mapId = (id: string): string => {
      if (!opts.regenerateIds) return id;
      if (!idMap.has(id)) idMap.set(id, generateId("pane"));
      return idMap.get(id)!;
    };

    const panes: Record<PaneId, TabPane> = Object.create(null);
    const build = (node: PersistedNode): PaneNode => {
      if (node.type === "leaf") {
        const paneId = mapId(node.id);
        const isActiveTarget = node.id === persisted.activePaneId && !!opts.overridePath;
        const path = isActiveTarget ? opts.overridePath! : node.path;
        sessions.reserve(paneId, () => createExplorerState(), (explorer) => explorer.initialLoad(path));
        panes[paneId] = { path, ...(node.gitGraph ? { gitGraph: node.gitGraph } : {}) };
        return leaf(paneId);
      }
      return {
        type: "split",
        id: opts.regenerateIds ? generateId("split") : node.id,
        direction: node.direction,
        ratio: node.ratio,
        first: build(node.first),
        second: build(node.second),
      };
    };

    const layout = build(persisted.layout);
    const paneIds = leafIds(layout);
    const mappedActive = mapId(persisted.activePaneId);
    return {
      [TAB_INSTANCE]: Symbol(),
      id: opts.regenerateIds ? generateId("tab") : persisted.id,
      kind: "explorer",
      layout,
      // Svelte only deeply proxies plain objects. Build safely with a null
      // prototype, then spread into a reactive dictionary; spread preserves
      // names such as __proto__ as own data properties without invoking setters.
      panes: { ...panes },
      activePaneId: paneIds.includes(mappedActive) ? mappedActive : paneIds[0],
      ...(persisted.name ? { name: persisted.name } : {}),
    };
  }

  /** Serialize a live tab for cross-window transfer / tear-off. */
  function exportTab(tabId: string): TabSnapshot | null {
    const tab = findTab(tabId);
    if (!tab) return null;
    return { path: getTabLivePath(tab), tab: persistTab(tab) };
  }

  /** Capture source ownership before awaiting destination adoption. */
  function beginTabTransfer(tabId: string): TabTransfer | null {
    const tab = findTab(tabId);
    if (!tab || disposal || closing) return null;
    const incarnation = tab[TAB_INSTANCE];
    if (transfers.has(incarnation)) return null;
    const snapshot = exportTab(tabId);
    if (!windowSeedFitsBudget(snapshot)) return null;
    const encoded = JSON.stringify(snapshot);
    let pending = true;
    transfers.add(incarnation);
    const cancel = () => {
      if (!pending) return;
      pending = false;
      transfers.delete(incarnation);
    };
    return {
      cancel,
      get snapshot(): TabSnapshot { return JSON.parse(encoded); },
      complete(): boolean {
        if (!pending) return false;
        cancel();
        if (disposal || closing || findTab(tabId)?.[TAB_INSTANCE] !== incarnation) return false;
        // Preserve navigation/layout edits the destination's captured payload
        // did not adopt. Reordering other tabs does not change this snapshot.
        const current = exportTab(tabId);
        if (!windowSeedFitsBudget(current) || JSON.stringify(current) !== encoded) return false;
        removeTransferredTab(tabId);
        return true;
      },
    };
  }

  /** Adopt a tab transferred from another window: rebuild it with fresh
   *  explorers (and fresh ids), insert at `index` (default: after active),
   *  and activate. */
  function adoptTab(snapshot: TabSnapshot, index?: number): WindowTab {
    const normalized = normalizeSnapshot(snapshot) ?? { path: "/home" };
    const tab = normalized.tab
      ? reviveTab(normalized.tab, { regenerateIds: true })
      : createTabObject(normalized.path);
    insertTab(tab, index ?? tabs.length);
    return tab;
  }

  /** Restore tabs from a persisted state (any shape; v1/v2 are migrated).
   *  @param overridePath - If set, the active tab's active pane navigates
   *    here instead of its saved path (avoids racing navigations). */
  function restoreFromState(state: PersistedTabState | unknown, overridePath?: string): void {
    requireOpenWindow();
    const normalized = normalizePersistedState(state);
    if (!normalized || normalized.tabs.length === 0) return;

    // Destroy before clearing — otherwise backend watch refcounts and
    // streaming listeners leak for every replaced explorer.
    paneActivation.cancel();
    transfers.clear();
    sessions.clear();

    tabs = normalized.tabs.map((pt) =>
      reviveTab(pt, {
        overridePath: pt.id === normalized.activeTabId ? overridePath : undefined,
      }),
    );
    activeTabId = normalized.activeTabId ?? tabs[0]?.id ?? null;
    activateTabResources(activeTabId);
  }

  /** Initialize - restores from localStorage or creates a new tab.
   *  @param skipRestore - When true, skip saved-state restoration and
   *    create a fresh tab at initialPath. Used for child windows spawned
   *    via Ctrl+N that receive their path via URL params.
   *  @param overridePath - When set, the active tab navigates here instead
   *    of its saved path. Used for CLI cwd so we don't race two navigations. */
  function init(initialPath: string, skipRestore = false, overridePath?: string): WindowTab | null {
    requireOpenWindow();
    testManagerRegistry()?.add(manager);
    if (!skipRestore) {
      // Try to restore from localStorage (cold start / app relaunch)
      const savedState = loadState();
      if (savedState && savedState.tabs.length > 0) {
        restoreFromState(savedState, overridePath);
        const restored = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
        if (restored) return restored;
      }
    }

    // No saved state or child window — create a fresh tab
    paneActivation.cancel();
    transfers.clear();
    sessions.clear();
    tabs = [];
    activeTabId = null;

    // Tear-off windows receive their tab through a label-keyed localStorage
    // seed written by the source window.
    const tabSeed = loadPersisted<unknown>(
      tabSeedKey(WINDOW_LABEL),
      null,
      WINDOW_SEED_MAX_CHARS,
    );
    removePersisted(tabSeedKey(WINDOW_LABEL));
    if (isRecord(tabSeed) && isFreshSeed(tabSeed.ts, Date.now(), 10_000)) {
      const snapshot = normalizeSnapshot(tabSeed.snapshot);
      if (snapshot) {
        const adopted = adoptTab(snapshot);
        void acknowledgeWindowHandoff(tabSeed.handoff, WINDOW_LABEL).catch(() => {});
        return adopted;
      }
    }

    // Check for parent-window seed (child windows get entries pre-loaded)
    const targetPath = overridePath ?? initialPath;
    const seedKey = directorySeedKey(WINDOW_LABEL);
    const seed = loadPersisted<unknown>(seedKey, null, WINDOW_SEED_MAX_CHARS);
    removePersisted(seedKey);
    const externalSeed = normalizeDirectorySeed(seed, targetPath, Date.now()) ?? undefined;

    return createTab(targetPath, externalSeed);
  }

  /** Snapshot a tab for Ctrl+Shift+T restoration */
  function snapshotTab(tab: WindowTab, tabIndex: number, fromClosedWindow = false): void {
    const snapshot: ClosedTabSnapshot = {
      path: getTabLivePath(tab),
      kind: tab.kind,
      tab: persistTab(tab),
      closedAt: tabIndex,
      fromClosedWindow,
      closedTs: Date.now(),
    };

    // Closing the last tab snapshots then attempts native destruction, which can
    // fail silently — repeated Ctrl+W would stack identical snapshots.
    if (fromClosedWindow) {
      const top = closedTabs.peek();
      if (
        top &&
        top.fromClosedWindow &&
        top.path === snapshot.path &&
        top.closedAt === snapshot.closedAt
      ) {
        return;
      }
    }

    closedTabs.push(snapshot);
  }

  /** Close a tab by ID. Closes the window if it's the last tab. */
  function closeTab(tabId: string): void {
    removeTab(tabId, { snapshot: true });
  }

  /** Remove a tab that moved to another window. No Ctrl+Shift+T snapshot —
   *  the tab still lives, just elsewhere. Closes the window if it was the
   *  last tab. */
  function removeTransferredTab(tabId: string): void {
    removeTab(tabId, { snapshot: false });
  }

  function destroyTabExplorers(tab: WindowTab): void {
    if (tab.kind !== "explorer") return;
    for (const paneId of Object.keys(tab.panes)) sessions.remove(paneId);
  }

  function removeTab(tabId: string, opts: { snapshot: boolean }): void {
    if (closing || disposal) return;
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex < 0) return;
    const tab = tabs[tabIndex];
    const isLast = tabs.length <= 1;

    // Snapshot before closing (even if it's the last tab)
    if (opts.snapshot) {
      snapshotTab(tab, tabIndex, isLast);
    }

    if (isLast) {
      const incarnation = tab[TAB_INSTANCE];
      if (!opts.snapshot) {
        // Ownership already moved: detach the source synchronously. If a new
        // tab opens while native close is loading, it keeps this window alive.
        destroyTabExplorers(tab);
        tabs = [];
        activeTabId = null;
        saveState();
      }
      void Promise.resolve().then(() => {
        const stillClosing = opts.snapshot
          ? tabs.length === 1 && findTab(tabId)?.[TAB_INSTANCE] === incarnation
          : tabs.length === 0;
        if (disposal || closing || !stillClosing) return;
        return windowClose.request();
      });
      return;
    }

    transfers.delete(tab[TAB_INSTANCE]);
    destroyTabExplorers(tab);

    const newTabs = tabs.filter((t) => t.id !== tabId);
    if (activeTabId === tabId) {
      const newIndex = Math.max(0, tabIndex - 1);
      activeTabId = newTabs[newIndex]?.id ?? null;
    }
    tabs = newTabs;
    activateTabResources(activeTabId);
    saveState();
  }

  /** Restore the most recently closed tab. Returns false if nothing to restore. */
  function restoreClosedTab(): false | RestoreResult {
    requireOpenWindow();
    // Re-read from localStorage to pick up snapshots from other windows
    closedTabs.refresh();
    const snapshot = closedTabs.pop();
    if (!snapshot) return false;

    // If the tab was from a closed window, signal to open a new window instead
    if (snapshot.fromClosedWindow) {
      return { restored: true, openInNewWindow: snapshot.path };
    }

    const at = Math.min(snapshot.closedAt, tabs.length);
    if (snapshot.tab) {
      insertTab(reviveTab(snapshot.tab, { regenerateIds: true }), at);
    } else if (snapshot.kind === "git-graph") {
      // Pre-#272 snapshot of a graph TAB: restore as a single-pane explorer
      // tab at the repo path with the graph showing.
      const tab = reviveTab(
        {
          id: generateId("tab"),
          kind: "explorer",
          layout: { type: "leaf", id: "restored-pane", path: snapshot.path, gitGraph: snapshot.path },
          activePaneId: "restored-pane",
        },
        { regenerateIds: true },
      );
      insertTab(tab, at);
    } else {
      adoptTab({ path: snapshot.path }, at);
    }
    return { restored: true };
  }

  /** Close the active tab */
  function closeActiveTab(): void {
    if (activeTabId) closeTab(activeTabId);
  }

  /** Close the focused surface, ghostty-style (#229): the focused pane when
   *  the active tab has several, otherwise the whole tab. */
  function closeSurface(): void {
    const tab = activeTab;
    if (tab?.kind === "explorer" && countLeaves(tab.layout) > 1) {
      closePane();
    } else {
      closeActiveTab();
    }
  }

  /** Drop pane snapshots whose tab no longer lives in this window (their
   *  close is superseded by the tab's own snapshot). */
  function pruneClosedPanes(): void {
    closedPanes = closedPanes.filter((p) => findTab(p.tabId)?.kind === "explorer");
  }

  /** Restore a closed pane back into its tab at its original split position.
   *  Falls back to splitting the focused pane when the sibling is gone. */
  function restorePane(snapshot: ClosedPaneSnapshot): void {
    const tab = findTab(snapshot.tabId);
    if (tab?.kind !== "explorer") return;
    setActiveTab(tab.id);
    const paneId = generateId("pane");
    createAndRegisterExplorer(paneId, snapshot.path, undefined, undefined, false);
    const splitId = generateId("split");
    updateActiveExplorerTab((t) => {
      const layout = hasNode(t.layout, snapshot.siblingId)
        ? updateRatio(
            splitNode(t.layout, snapshot.siblingId, snapshot.placement, paneId, splitId),
            splitId,
            snapshot.ratio,
          )
        : splitLeaf(t.layout, t.activePaneId, snapshot.placement, paneId, splitId);
      return {
        ...t,
        layout,
        panes: { ...t.panes, [paneId]: { path: snapshot.path } },
        activePaneId: paneId,
      };
    });
    saveState();
  }

  /** Restore the most recently closed surface (#229): the last closed pane
   *  when it's newer than the last closed tab, else the last closed tab.
   *  Returns false when there's nothing to restore. */
  function restoreClosedSurface(): false | RestoreResult {
    requireOpenWindow();
    closedTabs.refresh();
    pruneClosedPanes();
    const topPane = closedPanes[closedPanes.length - 1];
    if (topPane && topPane.ts >= (closedTabs.peek()?.closedTs ?? 0)) {
      closedPanes.pop();
      restorePane(topPane);
      return { restored: true };
    }
    return restoreClosedTab();
  }

  function activateTabResources(tabId: string | null): void {
    const tab = tabId ? findTab(tabId) : undefined;
    if (tab?.kind !== "explorer") { paneActivation.cancel(); return; }
    paneActivation.request(leafIds(tab.layout), tab.activePaneId);
  }

  /** Set the active tab */
  function setActiveTab(tabId: string): void {
    if (closing || disposal || !findTab(tabId)) return;
    activeTabId = tabId;
    activateTabResources(tabId);
    saveState();
  }

  /** Move to next tab (wraps around) */
  function nextTab(): void {
    cycleTab(1);
  }

  /** Move to previous tab (wraps around) */
  function prevTab(): void {
    cycleTab(-1);
  }

  function cycleTab(delta: number): void {
    if (closing || disposal || tabs.length <= 1) return;
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
    activeTabId = tabs[nextIndex].id;
    activateTabResources(activeTabId);
    saveState();
  }

  /** Rename a tab. Only multi-pane explorer tabs are renameable; the named
   *  layout is also saved as a workspace (#228) so it can be reopened from
   *  the command palette. */
  function renameTab(tabId: string, name: string): boolean {
    const tab = findTab(tabId);
    const trimmed = name.trim();
    if (!trimmed || !canRenameTab(tabId) || tab?.kind !== "explorer") return false;
    tabs = tabs.map((t) => (t.id === tabId ? { ...t, name: trimmed } : t));
    saveState();
    const renamed = findTab(tabId)!;
    workspacesStore.save(trimmed, {
      version: 3,
      tabs: [persistTab(renamed)],
      activeTabId: renamed.id,
    });
    return true;
  }

  /** A tab is renameable when it's an explorer tab with two or more panes. */
  function canRenameTab(tabId: string): boolean {
    const tab = findTab(tabId);
    return tab?.kind === "explorer" && countLeaves(tab.layout) > 1;
  }

  /** Get the explorer backing a pane (searched across all tabs, so pane-
   *  scoped components keep working during tab transitions). */
  function getExplorer(paneId: PaneId): ExplorerInstance | undefined {
    // Subscribe only to this pane's materialization, not every batch in the tab.
    paneReadiness.get(paneId);
    for (const tab of tabs) {
      if (tab.kind !== "explorer") continue;
      const pane = tab.panes[paneId];
      if (pane) return sessions.get(paneId);
    }
    return undefined;
  }

  /** Iterate instantiated explorers across every tab and pane. Unvisited
   *  restored tabs load fresh on activation and need no background refresh.
   *  Used by callers that need to broadcast a refresh to every pane that
   *  may currently be viewing an affected directory (e.g. cross-tab paste). */
  function getAllExplorers(): ExplorerInstance[] {
    return sessions.values();
  }

  /** Get the active explorer (active tab's active pane) */
  function getActiveExplorer(): ExplorerInstance | undefined {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return undefined;
    return sessions.get(tab.activePaneId);
  }

  /** Silently refresh the visible panes — for file operations (drops,
   *  pastes, external changes) that may affect any visible pane. Hidden
   *  tabs are skipped (no wasted IPC); they refresh on activation. */
  function refreshAllPanes(): void {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return;
    for (const paneId of leafIds(tab.layout)) {
      sessions.get(paneId)?.refresh({ silent: true });
    }
  }

  /** Update the active explorer tab's layout/panes in place (immutably). */
  function updateActiveExplorerTab(
    update: (tab: ManagedTab) => ManagedTab,
  ): ManagedTab | null {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return null;
    const updated = update(tab);
    tabs = tabs.map((t) => (t.id === tab.id ? updated : t));
    return updated;
  }

  /** Set the active (focused) pane of the active tab. */
  function setActivePane(paneId: PaneId): void {
    const tab = activeTab;
    if (tab?.kind !== "explorer" || tab.activePaneId === paneId) return;
    if (!tab.panes[paneId]) return;
    requireOpenWindow();
    sessions.activate(paneId);
    updateActiveExplorerTab((t) => ({ ...t, activePaneId: paneId }));
    saveState();
  }

  /** Focus the next pane of the active tab (cycles in visual order). */
  function switchPane(): void {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return;
    const ids = leafIds(tab.layout);
    if (ids.length <= 1) return;
    const idx = ids.indexOf(tab.activePaneId);
    setActivePane(ids[(idx + 1) % ids.length]);
  }

  /** Move focus to the pane adjacent to the focused one in `direction`
   *  (#501). Unlike `splitPane`, which creates a pane on that side, this
   *  only ever moves focus — with no pane there it is a no-op. */
  function focusPaneInDirection(direction: FocusDirection): void {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return;
    const target = leafInDirection(tab.layout, tab.activePaneId, direction);
    if (target !== null) setActivePane(target);
  }

  /** Split the active pane, placing a new pane on the given side.
   *  The new pane opens at `initialPath` (default: the source pane's
   *  directory, seeded with its entries so it renders instantly). */
  function splitPane(placement: SplitPlacement, initialPath?: string): void {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return;
    const sourceExplorer = getActiveExplorer();
    const sourcePath = panePath(tab, tab.activePaneId);
    const path = initialPath ?? sourcePath;
    const paneId = generateId("pane");
    createAndRegisterExplorer(paneId, path, sourceExplorer);
    updateActiveExplorerTab((t) => ({
      ...t,
      layout: splitLeaf(t.layout, t.activePaneId, placement, paneId, generateId("split")),
      panes: { ...t.panes, [paneId]: { path } },
      activePaneId: paneId,
    }));
    saveState();
  }

  /** Create a new pane according to the configured layout mode.
   *  Dwindle (default) splits the focused pane along its longer rendered
   *  axis (Hyprland-style); "right"/"down" always split that way. */
  function newPane(): void {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return;
    const mode = settingsStore.defaultPaneLayout;
    if (mode === "right" || mode === "down") {
      splitPane(mode);
      return;
    }
    const aspect =
      typeof window !== "undefined" && window.innerHeight > 0
        ? window.innerWidth / window.innerHeight
        : 16 / 9;
    splitPane(dwindlePlacement(tab.layout, tab.activePaneId, aspect));
  }

  /** Close a pane of the active tab (default: the focused pane).
   *  Closing the last pane closes the tab. */
  function closePane(paneId?: PaneId): void {
    if (closing || disposal) return;
    const tab = activeTab;
    if (tab?.kind !== "explorer") return;
    const target = paneId ?? tab.activePaneId;
    const pane = tab.panes[target];
    if (!pane) return;

    const newLayout = removeLeaf(tab.layout, target);
    if (newLayout === null) {
      closeTab(tab.id);
      return;
    }

    // Snapshot for Ctrl+Shift+T (#229): where the pane sat relative to its
    // sibling, so restore re-splits at the original position.
    const context = leafSiblingContext(tab.layout, target);
    if (context) {
      closedPanes.push({
        tabId: tab.id,
        path: panePath(tab, target),
        siblingId: context.siblingId,
        placement: context.placement,
        ratio: context.ratio,
        ts: Date.now(),
      });
      if (closedPanes.length > MAX_CLOSED_PANES) closedPanes.shift();
    }

    sessions.remove(target);

    const remaining = leafIds(newLayout);
    const oldOrder = leafIds(tab.layout);
    // Focus the nearest surviving pane (previous in visual order).
    const closedIndex = oldOrder.indexOf(target);
    const fallback = remaining[Math.max(0, Math.min(closedIndex - 1, remaining.length - 1))];
    if (tab.activePaneId === target) sessions.activate(fallback);
    updateActiveExplorerTab((t) => {
      const { [target]: _closed, ...panes } = t.panes;
      return {
        ...t,
        layout: newLayout,
        panes,
        activePaneId: t.activePaneId === target ? fallback : t.activePaneId,
        // A single-pane tab is no longer renameable — drop a stale custom name.
        ...(remaining.length === 1 ? { name: undefined } : {}),
      };
    });
    saveState();
  }

  /** Whether the active tab shows more than one pane (drives pane-scoped
   *  UI like focus borders and pane commands). */
  const multiPane = $derived(
    activeTab?.kind === "explorer" && countLeaves(activeTab.layout) > 1,
  );

  /** Toggle dual pane mode (Ctrl+\): a single-pane tab splits right —
   *  seeded at the parent directory, a more useful default than mirroring
   *  the same folder; a multi-pane tab collapses to just the focused pane. */
  function toggleDualPane(): void {
    const tab = activeTab;
    if (tab?.kind !== "explorer") return;

    if (countLeaves(tab.layout) > 1) {
      // Collapse: keep only the focused pane.
      for (const paneId of leafIds(tab.layout)) {
        if (paneId === tab.activePaneId) continue;
        sessions.remove(paneId);
      }
      updateActiveExplorerTab((t) => ({
        ...t,
        layout: leaf(t.activePaneId),
        panes: { [t.activePaneId]: t.panes[t.activePaneId] },
        name: undefined,
      }));
      saveState();
      return;
    }

    const currentPath = panePath(tab, tab.activePaneId);
    const parent = parentDir(currentPath);
    splitPane("right", parent && parent !== currentPath ? parent : currentPath);
  }

  /** Set dual pane mode */
  function setDualPane(enabled: boolean): void {
    if (multiPane === enabled) return;
    toggleDualPane();
  }

  /** Set a split's ratio on the active tab (divider drag). */
  function setSplitRatio(splitId: string, ratio: number): void {
    if (closing || disposal || activeTab?.kind !== "explorer") return;
    const layout = updateRatio(activeTab.layout, splitId, ratio);
    if (layout === activeTab.layout) return;
    updateActiveExplorerTab((t) => ({ ...t, layout }));
    saveState();
  }

  /** Capture the divider operation when a drag starts. */
  function beginSplitResize(splitId: string): (ratio: number) => boolean {
    const tab = activeTab;
    if (closing || disposal || tab?.kind !== "explorer"
      || findNode(tab.layout, splitId)?.type !== "split") return () => false;
    const incarnation = tab[TAB_INSTANCE];
    return (ratio) => {
      const current = activeTab;
      if (closing || disposal || current?.[TAB_INSTANCE] !== incarnation
        || current.kind !== "explorer" || findNode(current.layout, splitId)?.type !== "split") return false;
      setSplitRatio(splitId, ratio);
      return true;
    };
  }

  /** Reorder tabs within the strip */
  function reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= tabs.length) return;
    if (toIndex < 0 || toIndex >= tabs.length) return;
    if (fromIndex === toIndex) return;

    const newTabs = [...tabs];
    const [moved] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, moved);
    tabs = newTabs;
    saveState();
  }

  const manager = {
    // Tab state getters
    get tabs() {
      return tabs;
    },
    get activeTabId() {
      return activeTabId;
    },
    get activeTab() {
      return activeTab;
    },
    /** Mount identity survives edits but changes when a saved tab is revived. */
    get activeTabInstance() {
      return activeTab?.[TAB_INSTANCE];
    },
    get totalTabCount() {
      return tabs.length;
    },

    // Pane state (active tab)
    get activePaneId() {
      return activePaneId;
    },
    get activePaneIds() {
      return activePaneIds;
    },
    /** True when the active tab shows more than one pane. Kept under the
     *  historical name — command `when:` guards and pane chrome key off it. */
    get dualPaneEnabled() {
      return multiPane;
    },
    /** Whether `paneId` is the first (primary) pane of the active tab —
     *  singleton chrome like the SCM panel renders only there. */
    isPrimaryPane(paneId: PaneId): boolean {
      return activePaneIds[0] === paneId;
    },

    // Tab operations
    init,
    createTab,
    getPaneGitGraph,
    setPaneGitGraph,
    showGitGraphInPane,
    toggleGitGraphInActivePane,
    getPaneScmVisible,
    toggleScmInActivePane,
    closeTab,
    get acceptsTransfers() { return !closing && !disposal; },
    requestWindowClose: windowClose.request,
    observeNativeClose: windowClose.observe,
    closeActiveTab,
    closeSurface,
    exportTab,
    beginTabTransfer,
    adoptTab,
    get windowLabel() {
      return WINDOW_LABEL;
    },
    restoreClosedTab,
    restoreClosedSurface,
    get canRestoreTab() {
      // No side effects in the getter: the stack is refreshed on window
      // focus and explicitly before restore (restoreClosedTab).
      return closedTabs.size > 0;
    },
    get canRestoreSurface() {
      return closedTabs.size > 0 || closedPanes.some((p) => findTab(p.tabId)?.kind === "explorer");
    },
    setActiveTab,
    nextTab,
    prevTab,
    reorderTabs,
    renameTab,
    canRenameTab,
    getTabTitle,
    getTabDisplay,
    getTabPath,
    getPanePath,
    getTabTooltip,
    ensureGitRoot,
    getGitRoot,

    // Explorer access
    getExplorer,
    isPaneReady: (paneId: PaneId): boolean => paneReadiness.get(paneId) === true,
    getActiveExplorer,
    getAllExplorers,
    refreshAllPanes,

    // Pane operations (active tab)
    setActivePane,
    switchPane,
    focusPaneInDirection,
    splitPane,
    newPane,
    closePane,
    toggleDualPane,
    setDualPane,
    setSplitRatio,
    beginSplitResize,

    // Persistence
    save: saveStateNow,
    captureState,
    restoreFromState,

    /** Tear down this manager: remove the window focus listener and destroy
     *  all explorers. The app singleton lives for the whole session, but the
     *  factory is used in tests where undisposed managers would leak (#439).
     *  Ordering and failure propagation are defined by ADR 0002. */
    dispose(): Promise<void> {
      // Test teardown may call dispose after a legacy test has already started
      // it without awaiting. Share the same promise so every caller drains the
      // original explorer cleanup rather than observing its cleared registry.
      if (disposal) return disposal;
      windowClose.dispose();
      paneActivation.cancel();
      transfers.clear();
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onWindowFocus);
      }
      // Flushes a queued write before dropping its page-lifecycle listeners,
      // so tearing the manager down can't swallow the last interaction.
      tabStatePersister.dispose();
      disposal = sessions.dispose();
      void disposal.then(
        () => testManagerRegistry()?.delete(manager),
        () => testManagerRegistry()?.delete(manager),
      );
      return disposal;
    },
  };
  return manager;
}

/** Factory for creating window tabs managers - exported for testing */
export { createWindowTabsManager };

export const windowTabsManager = createWindowTabsManager();
