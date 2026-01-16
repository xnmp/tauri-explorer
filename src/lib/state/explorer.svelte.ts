/**
 * Explorer state management using Svelte 5 runes.
 * Issue: tauri-explorer-gcl, tauri-explorer-jql, tauri-explorer-h3n, tauri-explorer-x25, tauri-explorer-bhw5
 *
 * Refactored to use extracted utilities for:
 * - Types (types.ts)
 * - Selection logic (selection.ts)
 * - Navigation/history (navigation.ts)
 */

import {
  fetchDirectory,
  createDirectory,
  renameEntry,
  deleteEntry,
  copyEntry,
  moveEntry,
} from "$lib/api/files";
import { sortEntries, filterHidden, type FileEntry, type SortField } from "$lib/domain/file";
import type { ExplorerState, SelectOptions, UndoAction } from "./types";
import * as selection from "./selection";
import * as navigation from "./navigation";

function createExplorerState() {
  // Reactive state using $state rune
  let state = $state<ExplorerState>({
    // Navigation
    currentPath: "",
    history: [],
    historyIndex: -1,

    // Entries
    entries: [],
    loading: false,
    error: null,

    // View options
    showHidden: false,
    sortBy: "name",
    sortAscending: true,

    // Selection
    selectedPaths: new Set(),
    selectionAnchorIndex: null,

    // Dialogs
    newFolderDialogOpen: false,
    renamingEntry: null,
    deletingEntry: null,

    // Context menu
    contextMenuOpen: false,
    contextMenuPosition: null,

    // Clipboard & Undo
    clipboard: null,
    undoStack: [],
  });

  // ===================
  // Derived State
  // ===================

  const displayEntries = $derived.by(() => {
    const filtered = filterHidden(state.entries, state.showHidden);
    return sortEntries(filtered, state.sortBy, state.sortAscending);
  });

  const breadcrumbs = $derived(navigation.parseBreadcrumbs(state.currentPath));
  const canGoBack = $derived(navigation.canGoBack(state.historyIndex));
  const canGoForward = $derived(navigation.canGoForward(state.history, state.historyIndex));
  const canUndo = $derived(state.undoStack.length > 0);

  // ===================
  // Navigation Actions
  // ===================

  async function navigateInternal(path: string): Promise<boolean> {
    state.loading = true;
    state.error = null;

    const result = await fetchDirectory(path);

    if (result.ok) {
      state.currentPath = result.data.path;
      state.entries = [...result.data.entries];
      state.loading = false;
      return true;
    } else {
      state.error = result.error;
      state.loading = false;
      return false;
    }
  }

  async function navigateTo(path: string) {
    const success = await navigateInternal(path);
    if (success) {
      const newHistory = navigation.pushToHistory(
        state.history,
        state.historyIndex,
        state.currentPath
      );
      state.history = newHistory.history;
      state.historyIndex = newHistory.historyIndex;
    }
  }

  async function goBack() {
    const prevPath = navigation.getBackPath(state.history, state.historyIndex);
    if (!prevPath) return;
    const success = await navigateInternal(prevPath);
    if (success) {
      state.historyIndex--;
    }
  }

  async function goForward() {
    const nextPath = navigation.getForwardPath(state.history, state.historyIndex);
    if (!nextPath) return;
    const success = await navigateInternal(nextPath);
    if (success) {
      state.historyIndex++;
    }
  }

  function goUp() {
    const parentPath = navigation.getParentPath(breadcrumbs);
    if (parentPath) {
      navigateTo(parentPath);
    }
  }

  function refresh() {
    navigateTo(state.currentPath);
  }

  // ===================
  // View Actions
  // ===================

  function toggleHidden() {
    state.showHidden = !state.showHidden;
  }

  function setSorting(by: SortField) {
    if (state.sortBy === by) {
      state.sortAscending = !state.sortAscending;
    } else {
      state.sortBy = by;
      state.sortAscending = true;
    }
  }

  // ===================
  // Selection Actions
  // ===================

  function selectEntry(entry: FileEntry, options: SelectOptions = {}) {
    const result = selection.calculateSelection(
      displayEntries,
      entry,
      state.selectedPaths,
      state.selectionAnchorIndex,
      options
    );
    state.selectedPaths = result.selectedPaths;
    state.selectionAnchorIndex = result.anchorIndex;
  }

  function clearSelection() {
    state.selectedPaths = new Set();
    state.selectionAnchorIndex = null;
  }

  function isSelected(entry: FileEntry): boolean {
    return state.selectedPaths.has(entry.path);
  }

  function getSelectedEntries(): FileEntry[] {
    return selection.getSelectedEntries(displayEntries, state.selectedPaths);
  }

  function selectByIndices(indices: number[], addToSelection: boolean = false) {
    state.selectedPaths = selection.selectByIndices(
      displayEntries,
      indices,
      state.selectedPaths,
      addToSelection
    );
  }

  // ===================
  // Dialog Actions
  // ===================

  function openNewFolderDialog() {
    state.newFolderDialogOpen = true;
  }

  function closeNewFolderDialog() {
    state.newFolderDialogOpen = false;
  }

  function startRename(entry: FileEntry) {
    state.renamingEntry = entry;
  }

  function cancelRename() {
    state.renamingEntry = null;
  }

  function startDelete(entry: FileEntry) {
    state.deletingEntry = entry;
  }

  function cancelDelete() {
    state.deletingEntry = null;
  }

  // ===================
  // Context Menu Actions
  // ===================

  function openContextMenu(x: number, y: number, entry?: FileEntry) {
    if (entry) {
      // If right-clicked entry is not selected, select only it
      if (!state.selectedPaths.has(entry.path)) {
        state.selectedPaths = new Set([entry.path]);
        const entryIndex = displayEntries.findIndex((e) => e.path === entry.path);
        state.selectionAnchorIndex = entryIndex;
      }
    }
    state.contextMenuPosition = { x, y };
    state.contextMenuOpen = true;
  }

  function closeContextMenu() {
    state.contextMenuOpen = false;
    state.contextMenuPosition = null;
  }

  // ===================
  // File Operations
  // ===================

  async function createFolder(name: string): Promise<string | null> {
    if (!state.currentPath) return "No current directory";

    const result = await createDirectory(state.currentPath, name);

    if (result.ok) {
      state.entries = [...state.entries, result.data];
      state.newFolderDialogOpen = false;
      return null;
    }
    return result.error;
  }

  async function rename(newName: string): Promise<string | null> {
    if (!state.renamingEntry) return "No entry selected for rename";

    const oldName = state.renamingEntry.name;
    const oldPath = state.renamingEntry.path;
    const result = await renameEntry(oldPath, newName);

    if (result.ok) {
      state.undoStack = [
        ...state.undoStack,
        { type: "rename", path: result.data.path, oldName, newName },
      ];
      state.entries = state.entries.map((e) => (e.path === oldPath ? result.data : e));
      state.renamingEntry = null;
      return null;
    }
    return result.error;
  }

  async function confirmDelete(): Promise<string | null> {
    if (!state.deletingEntry) return "No entry selected for delete";

    const result = await deleteEntry(state.deletingEntry.path);

    if (result.ok) {
      state.entries = state.entries.filter((e) => e.path !== state.deletingEntry?.path);
      state.deletingEntry = null;
      return null;
    }
    return result.error;
  }

  // ===================
  // Clipboard Actions
  // ===================

  function copyToClipboard(entry: FileEntry) {
    state.clipboard = { entry, operation: "copy" };
  }

  function cutToClipboard(entry: FileEntry) {
    state.clipboard = { entry, operation: "cut" };
  }

  function clearClipboard() {
    state.clipboard = null;
  }

  async function paste(): Promise<string | null> {
    if (!state.clipboard) return "Nothing in clipboard";
    if (!state.currentPath) return "No current directory";

    const { entry, operation } = state.clipboard;
    const isCut = operation === "cut";
    const pasteOperation = isCut ? moveEntry : copyEntry;
    const originalDir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";

    const result = await pasteOperation(entry.path, state.currentPath);

    if (!result.ok) return result.error;

    if (isCut) {
      state.undoStack = [
        ...state.undoStack,
        {
          type: "move",
          sourcePath: entry.path,
          destPath: result.data.path,
          originalDir,
        },
      ];
    }

    state.entries = [...state.entries, result.data];
    state.clipboard = null;
    return null;
  }

  // ===================
  // Undo Actions
  // ===================

  async function undo(): Promise<string | null> {
    if (state.undoStack.length === 0) return "Nothing to undo";

    const action = state.undoStack[state.undoStack.length - 1];
    const result = await executeUndo(action);

    if (!result.ok) return result.error;

    state.undoStack = state.undoStack.slice(0, -1);
    await navigateInternal(state.currentPath);
    return null;
  }

  async function executeUndo(
    action: UndoAction
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    switch (action.type) {
      case "rename":
        return renameEntry(action.path, action.oldName);
      case "move":
        return moveEntry(action.destPath, action.originalDir);
    }
  }

  // ===================
  // Public API
  // ===================

  return {
    get state() {
      return state;
    },
    get displayEntries() {
      return displayEntries;
    },
    get breadcrumbs() {
      return breadcrumbs;
    },
    get canGoBack() {
      return canGoBack;
    },
    get canGoForward() {
      return canGoForward;
    },
    get canUndo() {
      return canUndo;
    },
    // Navigation
    navigateTo,
    goBack,
    goForward,
    goUp,
    refresh,
    // View
    toggleHidden,
    setSorting,
    // Selection
    selectEntry,
    clearSelection,
    isSelected,
    getSelectedEntries,
    selectByIndices,
    // Dialogs
    openNewFolderDialog,
    closeNewFolderDialog,
    startRename,
    cancelRename,
    startDelete,
    cancelDelete,
    // Context menu
    openContextMenu,
    closeContextMenu,
    // File operations
    createFolder,
    rename,
    confirmDelete,
    // Clipboard
    copyToClipboard,
    cutToClipboard,
    clearClipboard,
    paste,
    // Undo
    undo,
  };
}

export const explorer = createExplorerState();
