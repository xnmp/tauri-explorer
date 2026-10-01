/**
 * Persistence & migration helpers for window tabs.
 * Issues: tauri-explorer-ldfx (window tabs), #140 (per-pane tabs), #228
 * (window tabs own pane layout trees).
 *
 * Pure serialization types and shape-normalization/migration for the tab
 * state persisted to localStorage and saved workspaces. No runes, no
 * framework deps — the window-tabs manager consumes these to load/save.
 *
 * Format history:
 * - v1 (no version field): window-level tabs, each owning a left/right pane pair.
 * - v2: per-pane tab strips (#140) — the window owned two strips.
 * - v3 (#228): window-level tabs again; each explorer tab owns a pane
 *   layout tree (arbitrary splits), an active pane, and an optional name.
 */

import { clampSplitRatio, type PaneNode, type SplitDirection } from "$lib/domain/pane-layout";
import { isRecord, isWindowPath } from "$lib/domain/window-input";

const MAX_PERSISTED_TABS = 4096;
export const MAX_TOTAL_LAYOUT_NODES = 8192;

/** Cheap, iterative preflight that bounds current and legacy layouts before
 * migration or the canonical normalizer can traverse/map them. */
export function persistedStateAllocation(state: unknown, remaining = MAX_TOTAL_LAYOUT_NODES): number | null {
  if (!isRecord(state)) return null;
  let count = 0;
  const consume = (amount = 1) => {
    count += amount;
    return count <= remaining;
  };
  if (state.version === 3 && Array.isArray(state.tabs)) {
    if (state.tabs.length > MAX_PERSISTED_TABS || !consume(state.tabs.length)) return null;
    const pending = state.tabs.map((tab) => isRecord(tab) ? tab.layout : null);
    while (pending.length) {
      const node = pending.pop();
      if (!consume()) return null;
      if (!isRecord(node)) continue;
      if (node.type === "split") pending.push(node.first, node.second);
    }
    return count;
  }
  if (state.version === undefined && Array.isArray(state.tabs)) {
    if (state.tabs.length > MAX_PERSISTED_TABS || !consume(state.tabs.length * 3)) return null;
    return count;
  }
  if (state.version === 2 && isRecord(state.panes)) {
    const left = isRecord(state.panes.left) && Array.isArray(state.panes.left.tabs)
      ? state.panes.left.tabs.length : -1;
    const right = isRecord(state.panes.right) && Array.isArray(state.panes.right.tabs)
      ? state.panes.right.tabs.length : -1;
    if (left < 0 || right < 0 || left + right > MAX_PERSISTED_TABS || !consume((left + right) * 3)) return null;
    return count;
  }
  return null;
}

// ── v3 (current) ─────────────────────────────────────────────────────────

/** A pane layout tree with each leaf carrying its directory path.
 *  `gitGraph` marks a pane showing the commit graph for that repo (#272). */
export type PersistedNode =
  | { type: "leaf"; id: string; path: string; gitGraph?: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: PersistedNode;
      second: PersistedNode;
    };

export type PersistedWindowTab = {
  id: string;
  kind: "explorer";
  layout: PersistedNode;
  activePaneId: string;
  /** Custom title (multi-pane tabs can be renamed). */
  name?: string;
};

/** Pre-#272 shape: the git graph used to be its own tab kind. Accepted on
 *  input and migrated to a single-pane explorer tab with `gitGraph` set. */
type PersistedGitGraphTab = { id: string; kind: "git-graph"; path: string };

/** git-graph tab (pre-#272) → single-pane explorer tab showing the graph. */
function migrateGitGraphTab(t: PersistedGitGraphTab): PersistedWindowTab {
  return {
    id: t.id,
    kind: "explorer",
    layout: { type: "leaf", id: `${t.id}-pane`, path: t.path, gitGraph: t.path },
    activePaneId: `${t.id}-pane`,
  };
}

export interface PersistedTabState {
  version: 3;
  tabs: PersistedWindowTab[];
  activeTabId: string | null;
}

/** All leaf paths of a persisted layout, in visual order. */
export function persistedLeaves(node: PersistedNode): { id: string; path: string }[] {
  if (node.type === "leaf") return [{ id: node.id, path: node.path }];
  return [...persistedLeaves(node.first), ...persistedLeaves(node.second)];
}

/** Strip paths from a persisted layout, yielding the domain tree. */
export function toLayoutTree(node: PersistedNode): PaneNode {
  if (node.type === "leaf") return { type: "leaf", id: node.id };
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: toLayoutTree(node.first),
    second: toLayoutTree(node.second),
  };
}

function isPersistedNode(node: unknown): node is PersistedNode {
  // Saved workspaces are untrusted input. Bound depth before any recursive
  // layout operation and reject duplicate IDs (including cyclic objects).
  const pending = [{ node, depth: 0 }];
  const ids = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > 64 || ids.size >= 4096) return false;
    const n = next.node as PersistedNode;
    if (!n || !isWindowPath(n.id) || ids.has(n.id)) return false;
    ids.add(n.id);
    if (n.type === "leaf") {
      if (!isWindowPath(n.path) || (n.gitGraph !== undefined && !isWindowPath(n.gitGraph))) return false;
    } else if (n.type === "split") {
      if ((n.direction !== "row" && n.direction !== "column") || !Number.isFinite(n.ratio)) return false;
      pending.push({ node: n.first, depth: next.depth + 1 }, { node: n.second, depth: next.depth + 1 });
    } else return false;
  }
  return true;
}

type PersistedTabInput = PersistedWindowTab | PersistedGitGraphTab;

function isPersistedTabInput(tab: unknown): tab is PersistedTabInput {
  const t = tab as PersistedTabInput;
  if (!t || !isWindowPath(t.id)) return false;
  if (t.kind === "git-graph") return isWindowPath(t.path);
  if (t.kind === "explorer") return isPersistedNode(t.layout) && typeof t.activePaneId === "string"
    && (t.name === undefined || (typeof t.name === "string" && t.name.length <= 32_768));
  return false;
}

/** Validate any persisted tab shape and migrate pre-#272 git-graph tabs. */
function normalizePersistedTab(tab: unknown): PersistedWindowTab | null {
  if (!isPersistedTabInput(tab)) return null;
  const source = tab.kind === "git-graph" ? migrateGitGraphTab(tab) : tab;
  // Copy only validated fields; live state must not retain unknown payload
  // objects, and restored geometry follows the same policy as resizing.
  const copyNode = (node: PersistedNode): PersistedNode => node.type === "leaf"
    ? { type: "leaf", id: node.id, path: node.path, ...(node.gitGraph ? { gitGraph: node.gitGraph } : {}) }
    : { type: "split", id: node.id, direction: node.direction, ratio: clampSplitRatio(node.ratio), first: copyNode(node.first), second: copyNode(node.second) };
  const normalized: PersistedWindowTab = {
    id: source.id, kind: "explorer", layout: copyNode(source.layout), activePaneId: source.activePaneId,
    ...(source.name !== undefined ? { name: source.name } : {}),
  };
  const leaves = persistedLeaves(normalized.layout);
  return leaves.some((pane) => pane.id === normalized.activePaneId)
    ? normalized
    : { ...normalized, activePaneId: leaves[0].id };
}

// ── v2 (per-pane strips, #140) ───────────────────────────────────────────

export interface PersistedPaneTab {
  id: string;
  path: string;
  kind?: "explorer" | "git-graph";
}

export interface PersistedPaneTabs {
  tabs: PersistedPaneTab[];
  activeTabId: string | null;
}

export interface PersistedTabStateV2 {
  version: 2;
  panes: {
    left: PersistedPaneTabs;
    right: PersistedPaneTabs;
  };
  activePaneId: "left" | "right";
  dualPaneEnabled: boolean;
  splitRatio: number;
}

// ── v1 (pre-#140) ────────────────────────────────────────────────────────

interface LegacyPersistedTab {
  id: string;
  panes: { left: { path: string }; right: { path: string } };
  activePaneId: "left" | "right";
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

function isV2State(state: unknown): state is PersistedTabStateV2 {
  const s = state as PersistedTabStateV2;
  return (
    !!s &&
    s.version === 2 &&
    Array.isArray(s.panes?.left?.tabs) &&
    Array.isArray(s.panes?.right?.tabs)
  );
}

// ── Migrations ───────────────────────────────────────────────────────────

function singlePaneTab(id: string, path: string): PersistedWindowTab {
  return {
    id,
    kind: "explorer",
    layout: { type: "leaf", id: `${id}-pane`, path },
    activePaneId: `${id}-pane`,
  };
}

function dualPaneTab(
  id: string,
  leftPath: string,
  rightPath: string,
  ratio: number,
  activeSide: "left" | "right",
): PersistedWindowTab {
  const leftId = `${id}-pane-l`;
  const rightId = `${id}-pane-r`;
  return {
    id,
    kind: "explorer",
    layout: {
      type: "split",
      id: `${id}-split`,
      direction: "row",
      ratio: typeof ratio === "number" ? ratio : 0.5,
      first: { type: "leaf", id: leftId, path: leftPath },
      second: { type: "leaf", id: rightId, path: rightPath },
    },
    activePaneId: activeSide === "right" ? rightId : leftId,
  };
}

/** v1 → v3: each legacy tab maps naturally onto a one- or two-pane tab. */
export function migrateLegacyState(legacy: LegacyPersistedTabState): PersistedTabState {
  const tabs = (Array.isArray(legacy.tabs) ? legacy.tabs : []).map((t): PersistedWindowTab => {
    const leftPath = t.panes?.left?.path || "/home";
    const rightPath = t.panes?.right?.path;
    return t.dualPaneEnabled && rightPath
      ? dualPaneTab(t.id, leftPath, rightPath, t.splitRatio, t.activePaneId)
      : singlePaneTab(t.id, leftPath);
  });
  const activeTabId = tabs.some((t) => t.id === legacy.activeTabId)
    ? legacy.activeTabId
    : (tabs[0]?.id ?? null);
  return { version: 3, tabs, activeTabId };
}

/**
 * v2 → v3: every strip tab becomes a window tab. When dual-pane was on,
 * the two ACTIVE strip tabs merge into one two-pane tab (preserving the
 * visible layout); the rest become single-pane tabs in strip order
 * (left strip first).
 */
export function migrateV2State(v2: PersistedTabStateV2): PersistedTabState {
  const left = v2.panes.left;
  const right = v2.panes.right;
  const activeLeft = left.tabs.find((t) => t.id === left.activeTabId);
  const activeRight = right.tabs.find((t) => t.id === right.activeTabId);
  const merge =
    v2.dualPaneEnabled &&
    activeLeft &&
    activeRight &&
    activeLeft.kind !== "git-graph" &&
    activeRight.kind !== "git-graph";

  const tabs: PersistedWindowTab[] = [];
  let activeTabId: string | null = null;

  for (const strip of [left, right]) {
    for (const t of strip.tabs) {
      if (t.kind === "git-graph") {
        tabs.push(migrateGitGraphTab({ id: t.id, kind: "git-graph", path: t.path }));
        continue;
      }
      if (merge && t.id === activeLeft.id) {
        const merged = dualPaneTab(
          t.id,
          activeLeft.path,
          activeRight.path,
          v2.splitRatio,
          v2.activePaneId,
        );
        tabs.push(merged);
        activeTabId = merged.id;
        continue;
      }
      if (merge && t.id === activeRight.id) continue; // consumed by the merge
      tabs.push(singlePaneTab(t.id, t.path));
    }
  }

  if (!activeTabId) {
    const active = v2.activePaneId === "right" ? right.activeTabId : left.activeTabId;
    activeTabId = tabs.some((t) => t.id === active) ? active : (tabs[0]?.id ?? null);
  }
  return { version: 3, tabs, activeTabId };
}

/** Accept any persisted shape, migrating v1/v2 on the fly. */
export function normalizePersistedState(state: unknown): PersistedTabState | null {
  if (persistedStateAllocation(state) === null) return null;
  // Run migrated data through the same identity validation as current data.
  // Invalid legacy fields must not abort startup before its default pane exists.
  try {
    if (isLegacyState(state)) return normalizePersistedState(migrateLegacyState(state));
    if (isV2State(state)) return normalizePersistedState(migrateV2State(state));
  } catch { return null; }
  const s = state as PersistedTabState;
  if (s.version === 3 && Array.isArray(s.tabs)) {
    const tabIds = new Set<string>();
    const paneIds = new Set<string>();
    const tabs = s.tabs.map(normalizePersistedTab).filter((tab): tab is PersistedWindowTab => {
      if (!tab || tabIds.has(tab.id)) return false;
      const ids = persistedLeaves(tab.layout).map((pane) => pane.id);
      if (ids.some((id) => paneIds.has(id))) return false;
      tabIds.add(tab.id);
      ids.forEach((id) => paneIds.add(id));
      return true;
    });
    return {
      version: 3,
      tabs,
      activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[0]?.id ?? null),
    };
  }
  return null;
}

/** Total tab count in a persisted state of any shape (workspace list UI). */
export function countPersistedTabs(state: unknown): number {
  return normalizePersistedState(state)?.tabs.length ?? 0;
}

/** Total pane count in a persisted state of any shape (workspace list UI). */
export function countPersistedPanes(state: unknown): number {
  const s = normalizePersistedState(state);
  if (!s) return 0;
  return s.tabs.reduce(
    (n, t) => n + (t.kind === "explorer" ? persistedLeaves(t.layout).length : 1),
    0,
  );
}

// ── Live-tab snapshots (cross-window transfer, tear-off, Ctrl+Shift+T) ───

/**
 * Serializable snapshot of a live tab. `path` (the active pane's path) is
 * kept for backward compatibility and for consumers that need a single
 * representative path (tear-off window seeds); `tab` carries the full
 * layout when the source runs a v3 build.
 */
export interface TabSnapshot {
  path: string;
  tab?: PersistedWindowTab;
}

/** Tolerate snapshots written by older builds (v1 pane pairs, v2 paths). */
export function normalizeSnapshot(raw: unknown): TabSnapshot | null {
  if (!isRecord(raw)) return null;
  if (isWindowPath(raw.path)) {
    const tab = normalizePersistedTab(raw.tab);
    return tab ? { path: raw.path, tab } : { path: raw.path };
  }
  if (isWindowPath(raw.leftPath)) {
    return { path: raw.activePaneId === "right" && isWindowPath(raw.rightPath) ? raw.rightPath : raw.leftPath };
  }
  return null;
}

/** Fresh children consume only the directory seed addressed to their label. */
export function directorySeedKey(windowLabel: string): string {
  return `dir-seed:${windowLabel}`;
}

/** localStorage key a freshly spawned tear-off window reads its tab from. */
export function tabSeedKey(windowLabel: string): string {
  return `tab-seed:${windowLabel}`;
}

/** Snapshot of a closed tab for restoration via Ctrl+Shift+T. */
export interface ClosedTabSnapshot {
  path: string;
  /** Tab kind (#56); absent in old snapshots — treated as "explorer". */
  kind?: "explorer" | "git-graph";
  /** Full tab payload (v3 builds) so multi-pane tabs restore intact. */
  tab?: PersistedWindowTab;
  closedAt: number; // insertion index within the window's tab strip
  fromClosedWindow: boolean; // true if this was the last tab when window closed
  /** Wall-clock close time (#229) — ordered against closed PANES so
   *  Ctrl+Shift+T restores the most recently closed surface. Absent in
   *  old snapshots (treated as 0, i.e. older than any pane close). */
  closedTs?: number;
}

/** Tolerate closed-tab snapshots persisted by older builds. */
export function normalizeClosedSnapshot(raw: unknown): ClosedTabSnapshot | null {
  const snapshot = normalizeSnapshot(raw);
  if (!snapshot || !isRecord(raw)) return null;
  return {
    ...snapshot,
    ...(raw.kind === "explorer" || raw.kind === "git-graph" ? { kind: raw.kind } : {}),
    closedAt: typeof raw.closedAt === "number" && Number.isSafeInteger(raw.closedAt) && raw.closedAt >= 0 ? raw.closedAt : 0,
    fromClosedWindow: raw.fromClosedWindow === true,
    ...(typeof raw.closedTs === "number" && Number.isSafeInteger(raw.closedTs) && raw.closedTs >= 0 ? { closedTs: raw.closedTs } : {}),
  };
}

/** Result of restoring a closed tab */
export interface RestoreResult {
  restored: true;
  /** If the closed tab was from a closed window, the path to open in a new window */
  openInNewWindow?: string;
}
