/**
 * Type definitions for explorer state.
 * Extracted from explorer.svelte.ts for reusability.
 */

/** Available view modes for the file list */
import type { ViewMode } from "$lib/domain/file";
export type { ViewMode } from "$lib/domain/file";

/** Undoable action types — canonical definition lives in domain (#278). */
export type { UndoAction } from "$lib/domain/undo-operations";

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
 * non-explorer content. The git graph is no longer a tab kind — it renders
 * per-pane (#272) — but the discriminant stays for future kinds.
 */
export type WindowTab = ExplorerTab;

/** Presentation state of a pane. Its layout ID also identifies its session.
 *  `path` is the creation/restore path; the live path comes from the
 *  explorer instance. */
export interface TabPane {
  path: string;
  /** When set, the pane shows the commit graph for this repo root instead
   *  of the file listing (#272). Toggled by `git.showGraph`. */
  gitGraph?: string;
  /** Per-pane SCM panel visibility override (#434). `undefined` = follow the
   *  global `showScmPanel` setting; `true`/`false` = an explicit per-pane
   *  choice made via the toggle command. In-memory only (not persisted). */
  scmPanel?: boolean;
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
