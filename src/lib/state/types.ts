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

/** Pane identifiers for dual pane layout */
export type PaneId = "left" | "right";

/**
 * A single tab within a pane's tab strip. Each pane owns its own list of
 * tabs; a tab references its explorer instance by ID.
 */
export interface PaneTab {
  id: string;
  explorerId: string;
  path: string;
  title: string;
}

/** A pane's tab strip: its tabs and which one is active. */
export interface PaneTabs {
  tabs: PaneTab[];
  activeTabId: string | null;
}
