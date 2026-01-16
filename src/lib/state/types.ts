/**
 * Type definitions for explorer state.
 * Extracted from explorer.svelte.ts for reusability.
 */

import type { FileEntry, SortField } from "$lib/domain/file";

/** Available view modes for the file list */
export type ViewMode = "details" | "list" | "tiles";

/** Clipboard state for copy/cut operations */
export interface ClipboardState {
  entry: FileEntry;
  operation: "copy" | "cut";
}

/** Undoable action types */
export type UndoAction =
  | { type: "rename"; path: string; oldName: string; newName: string }
  | { type: "move"; sourcePath: string; destPath: string; originalDir: string };

/** Core explorer state */
export interface ExplorerState {
  // Navigation
  currentPath: string;
  history: string[];
  historyIndex: number;

  // Entries
  entries: FileEntry[];
  loading: boolean;
  error: string | null;

  // View options
  showHidden: boolean;
  sortBy: SortField;
  sortAscending: boolean;
  viewMode: ViewMode;

  // Selection
  selectedPaths: Set<string>;
  selectionAnchorIndex: number | null;

  // Dialogs
  newFolderDialogOpen: boolean;
  renamingEntry: FileEntry | null;
  deletingEntry: FileEntry | null;

  // Context menu
  contextMenuOpen: boolean;
  contextMenuPosition: { x: number; y: number } | null;

  // Clipboard & Undo
  clipboard: ClipboardState | null;
  undoStack: UndoAction[];
}

/** Selection options for click handlers */
export interface SelectOptions {
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** Pane identifiers for dual pane layout */
export type PaneId = "left" | "right";

/** Pane layout configuration */
export interface PaneLayoutState {
  activePaneId: PaneId;
  splitRatio: number; // 0-1, position of divider
  dualPaneEnabled: boolean;
}
