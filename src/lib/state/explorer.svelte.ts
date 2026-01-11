/**
 * Explorer state management using Svelte 5 runes.
 * Issue: tauri-explorer-gcl, tauri-explorer-jql, tauri-explorer-h3n, tauri-explorer-x25
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

  // Actions
  async function navigateTo(path: string) {
    state.loading = true;
    state.error = null;

    const result = await fetchDirectory(path);

    if (result.ok) {
      state.currentPath = result.data.path;
      state.entries = [...result.data.entries];
    } else {
      state.error = result.error;
    }

    state.loading = false;
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

    const result = await renameEntry(state.renamingEntry.path, newName);

    if (result.ok) {
      // Update entry in list
      state.entries = state.entries.map((e) =>
        e.path === state.renamingEntry?.path ? result.data : e
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

  async function paste(): Promise<string | null> {
    if (!state.clipboard) return "Nothing in clipboard";
    if (!state.currentPath) return "No current directory";

    const { entry, operation } = state.clipboard;

    if (operation === "copy") {
      const result = await copyEntry(entry.path, state.currentPath);
      if (result.ok) {
        state.entries = [...state.entries, result.data];
        return null;
      } else {
        return result.error;
      }
    } else {
      // cut = move
      const result = await moveEntry(entry.path, state.currentPath);
      if (result.ok) {
        state.entries = [...state.entries, result.data];
        state.clipboard = null; // Clear clipboard after cut
        return null;
      } else {
        return result.error;
      }
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
    navigateTo,
    toggleHidden,
    setSorting,
    goUp,
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
  };
}

export const explorer = createExplorerState();
