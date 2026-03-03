/**
 * Type definitions for explorer state.
 * Extracted from explorer.svelte.ts for reusability.
 */

/** Available view modes for the file list */
export type ViewMode = "details" | "list" | "tiles";

/** Undoable action types */
export type UndoAction =
  | { type: "rename"; path: string; oldName: string; newName: string }
  | { type: "move"; sourcePath: string; destPath: string; originalDir: string };

/** Selection options for click handlers */
export interface SelectOptions {
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** Pane identifiers for dual pane layout */
export type PaneId = "left" | "right";

/**
 * Window-level tab that contains the full dual-pane layout state.
 * Each tab independently tracks both panes, active pane, and layout settings.
 */
export interface WindowTab {
  id: string;
  panes: {
    left: WindowTabPane;
    right: WindowTabPane;
  };
  activePaneId: PaneId;
  dualPaneEnabled: boolean; // Per-tab: one tab can be single-pane, another dual-pane
  splitRatio: number; // Per-tab: each tab remembers its divider position
}

/**
 * Pane state within a window tab.
 * References an explorer instance by ID for state management.
 */
export interface WindowTabPane {
  explorerId: string;
  path: string;
  title: string;
}
