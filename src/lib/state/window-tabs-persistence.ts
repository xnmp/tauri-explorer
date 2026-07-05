/**
 * Persistence & migration helpers for per-pane window tabs.
 * Issues: tauri-explorer-ldfx (window tabs), #140 (dual-pane-as-windows)
 * Issue: refactor/audit-tier4-splits (#212)
 *
 * Pure serialization types and shape-normalization/migration for the tab
 * state persisted to localStorage and saved workspaces. No runes, no
 * framework deps — the window-tabs manager consumes these to load/save.
 */

import type { PaneId } from "./types";

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
export interface LegacyPersistedTabState {
  tabs: LegacyPersistedTab[];
  activeTabId: string | null;
}

export function isLegacyState(state: unknown): state is LegacyPersistedTabState {
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
  if (
    s.version === 2 &&
    Array.isArray(s.panes?.left?.tabs) &&
    Array.isArray(s.panes?.right?.tabs)
  ) {
    return s;
  }
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
export function normalizeSnapshot(raw: unknown): TabSnapshot | null {
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

/** Snapshot of a closed tab for restoration via Ctrl+Shift+T */
export interface ClosedTabSnapshot {
  path: string;
  paneId: PaneId;
  /** Tab kind (#56); absent in old snapshots — treated as "explorer". */
  kind?: "explorer" | "git-graph";
  closedAt: number; // insertion index within its pane's strip
  fromClosedWindow: boolean; // true if this was the last tab when window closed
}

/** Tolerate v1 closed-tab snapshots persisted by a pre-inversion build. */
export function normalizeClosedSnapshot(raw: unknown): ClosedTabSnapshot | null {
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

/** Result of restoring a closed tab */
export interface RestoreResult {
  restored: true;
  /** If the closed tab was from a closed window, the path to open in a new window */
  openInNewWindow?: string;
}
