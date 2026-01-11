/**
 * Explorer state management using Svelte 5 runes.
 * Issue: tauri-explorer-gcl
 */

import { fetchDirectory } from "$lib/api/files";
import {
  sortEntries,
  filterHidden,
  type FileEntry,
  type SortField,
} from "$lib/domain/file";

interface ExplorerState {
  currentPath: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  sortBy: SortField;
  sortAscending: boolean;
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
  };
}

export const explorer = createExplorerState();
