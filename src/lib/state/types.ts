/**
 * Type definitions for explorer state.
 * Extracted from explorer.svelte.ts for reusability.
 */

/** Available view modes for the file list */
export type ViewMode = "details" | "list" | "tiles";

/** Undoable action types */
export type UndoAction =
  | { type: "rename"; path: string; oldName: string; newName: string }
  | { type: "move"; sourcePath: string; destPath: string; originalDir: string }
  | { type: "copy"; copiedPath: string; parentDir: string }
  | { type: "batch"; actions: UndoAction[]; label: string }
  | { type: "delete"; paths: string[]; parentDir: string };

/** Selection options for click handlers */
export interface SelectOptions {
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Core per-pane explorer state. Owned by explorer.svelte.ts (as a $state
 * proxy) and shared with the pane-* modules, which mutate it through the
 * proxy so reactivity is preserved.
 */
export interface ExplorerCoreState {
  // Navigation
  currentPath: string;
  history: string[];
  historyIndex: number;

  // Entries
  entries: import("$lib/domain/file").FileEntry[];
  loading: boolean;
  error: string | null;

  // View options (showHidden is in settingsStore, shared across panes)
  sortBy: import("$lib/domain/file").SortField;
  sortAscending: boolean;
  viewMode: ViewMode;

  // Selection
  selectedPaths: Set<string>;
  selectionAnchorIndex: number | null;
}

/**
 * Pane identifier: the id of a leaf in a tab's pane layout tree (#228).
 * Opaque — pane-scoped components pass it through to the manager.
 */
export type PaneId = string;

/**
 * A window-level tab, as a tagged union (#56) so tabs can host
 * non-explorer content (git graph, settings, diff-only, …).
 */
export type WindowTab = ExplorerTab | GitGraphTab;

/** @deprecated alias kept from the per-pane-tabs era (#140). */
export type PaneTab = WindowTab;

/** A pane within an explorer tab: references its explorer instance by ID.
 *  `path` is the creation/restore path; the live path comes from the
 *  explorer instance. */
export interface TabPane {
  explorerId: string;
  path: string;
}

/** A filesystem explorer tab owning a pane layout tree (#228). Leaf ids of
 *  `layout` key into `panes`. */
export interface ExplorerTab {
  id: string;
  kind: "explorer";
  layout: import("$lib/domain/pane-layout").PaneNode;
  panes: Record<PaneId, TabPane>;
  activePaneId: PaneId;
  /** Custom title — only multi-pane tabs can be renamed. */
  name?: string;
}

/** A git history graph for a repository (#51). */
export interface GitGraphTab {
  id: string;
  kind: "git-graph";
  repoPath: string;
  title: string;
}
