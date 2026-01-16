/**
 * Type definitions for explorer state.
 * Extracted from explorer.svelte.ts for reusability.
 */

import type { FileEntry, SortField } from "$lib/domain/file";

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
