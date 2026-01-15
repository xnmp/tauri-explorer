/**
 * Explorer state management using Svelte 5 runes.
 * Issue: tauri-explorer-gcl, tauri-explorer-jql, tauri-explorer-h3n, tauri-explorer-x25, tauri-explorer-bhw5
 */

import {
  fetchDirectory,
  createDirectory,
  renameEntry,
  deleteEntry,
  copyEntry,
  moveEntry,
} from "$lib/api/files";
import {
  sortEntries,
  filterHidden,
  type FileEntry,
  type SortField,
} from "$lib/domain/file";

interface ClipboardState {
  entry: FileEntry;
  operation: "copy" | "cut";
}

/** Undoable action types */
type UndoAction =
  | { type: "rename"; path: string; oldName: string; newName: string }
  | { type: "move"; sourcePath: string; destPath: string; originalDir: string };

interface ExplorerState {
  currentPath: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  sortBy: SortField;
  sortAscending: boolean;
  newFolderDialogOpen: boolean;
  renamingEntry: FileEntry | null;
  deletingEntry: FileEntry | null;
  clipboard: ClipboardState | null;
  selectedPaths: Set<string>;
  selectionAnchorIndex: number | null;
  contextMenuOpen: boolean;
  contextMenuPosition: { x: number; y: number } | null;
  // Navigation history
  history: string[];
  historyIndex: number;
  // Undo stack
  undoStack: UndoAction[];
}

function createExplorerState() {
  // Reactive state using $state rune
  let state = $state<ExplorerState>({
    currentPath: "",
    entries: [],
    loading: false,
    error: null,
    showHidden: false,
    sortBy: "name",
    sortAscending: true,
    newFolderDialogOpen: false,
    renamingEntry: null,
    deletingEntry: null,
    clipboard: null,
    selectedPaths: new Set(),
    selectionAnchorIndex: null,
    contextMenuOpen: false,
    contextMenuPosition: null,
    history: [],
    historyIndex: -1,
    undoStack: [],
  });

  // Derived: processed entries with sorting and filtering
  const displayEntries = $derived.by(() => {
    const filtered = filterHidden(state.entries, state.showHidden);
    return sortEntries(filtered, state.sortBy, state.sortAscending);
  });

  // Derived: breadcrumb segments from current path
  const breadcrumbs = $derived.by(() => {
    const path = state.currentPath;
    if (!path) return [];

    const parts = path.split(/[/\\]/).filter(Boolean);
    const result: { name: string; path: string }[] = [];

    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : `/${part}`;
      result.push({ name: part, path: accumulated });
    }

    return result;
  });

  // Derived: navigation state
  const canGoBack = $derived(state.historyIndex > 0);
  const canGoForward = $derived(state.historyIndex < state.history.length - 1);
  const canUndo = $derived(state.undoStack.length > 0);

  // Internal: navigate without modifying history (used by goBack/goForward)
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

  // Actions
  async function navigateTo(path: string) {
    const success = await navigateInternal(path);

    if (success) {
      // Truncate forward history and push new path
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(state.currentPath);
      state.history = newHistory;
      state.historyIndex = newHistory.length - 1;
    }
  }

  async function goBack() {
    if (!canGoBack) return;
    const prevPath = state.history[state.historyIndex - 1];
    const success = await navigateInternal(prevPath);
    if (success) {
      state.historyIndex--;
    }
  }

  async function goForward() {
    if (!canGoForward) return;
    const nextPath = state.history[state.historyIndex + 1];
    const success = await navigateInternal(nextPath);
    if (success) {
      state.historyIndex++;
    }
  }

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

  function goUp() {
    if (breadcrumbs.length > 1) {
      navigateTo(breadcrumbs[breadcrumbs.length - 2].path);
    } else if (breadcrumbs.length === 1) {
      navigateTo("/");
    }
  }

  function refresh() {
    navigateTo(state.currentPath);
  }

  function openNewFolderDialog() {
    state.newFolderDialogOpen = true;
  }

  function closeNewFolderDialog() {
    state.newFolderDialogOpen = false;
  }

  async function createFolder(name: string): Promise<string | null> {
    if (!state.currentPath) return "No current directory";

    const result = await createDirectory(state.currentPath, name);

    if (result.ok) {
      // Add new entry to list and refresh
      state.entries = [...state.entries, result.data];
      state.newFolderDialogOpen = false;
      return null;
    } else {
      return result.error;
    }
  }

  function startRename(entry: FileEntry) {
    state.renamingEntry = entry;
  }

  function cancelRename() {
    state.renamingEntry = null;
  }

  async function rename(newName: string): Promise<string | null> {
    if (!state.renamingEntry) return "No entry selected for rename";

    const oldName = state.renamingEntry.name;
    const oldPath = state.renamingEntry.path;
    const result = await renameEntry(oldPath, newName);

    if (result.ok) {
      // Push to undo stack
      state.undoStack = [
        ...state.undoStack,
        { type: "rename", path: result.data.path, oldName, newName },
      ];

      // Update entry in list
      state.entries = state.entries.map((e) =>
        e.path === oldPath ? result.data : e
      );
      state.renamingEntry = null;
      return null;
    } else {
      return result.error;
    }
  }

  function startDelete(entry: FileEntry) {
    state.deletingEntry = entry;
  }

  function cancelDelete() {
    state.deletingEntry = null;
  }

  async function confirmDelete(): Promise<string | null> {
    if (!state.deletingEntry) return "No entry selected for delete";

    const result = await deleteEntry(state.deletingEntry.path);

    if (result.ok) {
      // Remove entry from list
      state.entries = state.entries.filter(
        (e) => e.path !== state.deletingEntry?.path
      );
      state.deletingEntry = null;
      return null;
    } else {
      return result.error;
    }
  }

  function copyToClipboard(entry: FileEntry) {
    state.clipboard = { entry, operation: "copy" };
  }

  function cutToClipboard(entry: FileEntry) {
    state.clipboard = { entry, operation: "cut" };
  }

  function clearClipboard() {
    state.clipboard = null;
  }

  interface SelectOptions {
    ctrlKey?: boolean;
    shiftKey?: boolean;
  }

  function selectEntry(entry: FileEntry, options: SelectOptions = {}) {
    const entryIndex = displayEntries.findIndex((e) => e.path === entry.path);
    if (entryIndex === -1) return;

    if (options.shiftKey && state.selectionAnchorIndex !== null) {
      // Shift+click: select range from anchor to clicked item
      const start = Math.min(state.selectionAnchorIndex, entryIndex);
      const end = Math.max(state.selectionAnchorIndex, entryIndex);
      const newSelection = new Set<string>();
      for (let i = start; i <= end; i++) {
        newSelection.add(displayEntries[i].path);
      }
      state.selectedPaths = newSelection;
      // Don't update anchor on shift+click
    } else if (options.ctrlKey) {
      // Ctrl+click: toggle selection
      const newSelection = new Set(state.selectedPaths);
      if (newSelection.has(entry.path)) {
        newSelection.delete(entry.path);
      } else {
        newSelection.add(entry.path);
      }
      state.selectedPaths = newSelection;
      state.selectionAnchorIndex = entryIndex;
    } else {
      // Normal click: single select
      state.selectedPaths = new Set([entry.path]);
      state.selectionAnchorIndex = entryIndex;
    }
  }

  function clearSelection() {
    state.selectedPaths = new Set();
    state.selectionAnchorIndex = null;
  }

  function isSelected(entry: FileEntry): boolean {
    return state.selectedPaths.has(entry.path);
  }

  function getSelectedEntries(): FileEntry[] {
    return displayEntries.filter((e) => state.selectedPaths.has(e.path));
  }

  function selectByIndices(indices: number[], addToSelection: boolean = false) {
    const pathsToSelect = indices
      .filter((i) => i >= 0 && i < displayEntries.length)
      .map((i) => displayEntries[i].path);

    if (addToSelection) {
      const newSelection = new Set(state.selectedPaths);
      for (const path of pathsToSelect) {
        newSelection.add(path);
      }
      state.selectedPaths = newSelection;
    } else {
      state.selectedPaths = new Set(pathsToSelect);
    }
  }

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

  async function paste(): Promise<string | null> {
    if (!state.clipboard) return "Nothing in clipboard";
    if (!state.currentPath) return "No current directory";

    const { entry, operation } = state.clipboard;
    const isCut = operation === "cut";
    const pasteOperation = isCut ? moveEntry : copyEntry;

    // Extract original directory from source path
    const originalDir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";

    const result = await pasteOperation(entry.path, state.currentPath);

    if (!result.ok) {
      return result.error;
    }

    // Push move operation to undo stack (cut/paste = move)
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

  async function undo(): Promise<string | null> {
    if (state.undoStack.length === 0) return "Nothing to undo";

    const action = state.undoStack[state.undoStack.length - 1];

    const result = await executeUndo(action);
    if (!result.ok) return result.error;

    // Only remove from stack after successful undo
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
    navigateTo,
    goBack,
    goForward,
    toggleHidden,
    setSorting,
    goUp,
    refresh,
    openNewFolderDialog,
    closeNewFolderDialog,
    createFolder,
    startRename,
    cancelRename,
    rename,
    startDelete,
    cancelDelete,
    confirmDelete,
    copyToClipboard,
    cutToClipboard,
    clearClipboard,
    paste,
    selectEntry,
    clearSelection,
    isSelected,
    getSelectedEntries,
    selectByIndices,
    openContextMenu,
    closeContextMenu,
    undo,
  };
}

export const explorer = createExplorerState();
