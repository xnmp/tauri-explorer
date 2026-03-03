/**
 * Explorer state management using Svelte 5 runes.
 * Issue: tauri-explorer-gcl, tauri-explorer-jql, tauri-explorer-h3n, tauri-explorer-x25, tauri-explorer-bhw5, tauri-explorer-u7bg, tauri-explorer-1k9k
 *
 * Refactored to use extracted stores for:
 * - Types (types.ts)
 * - Selection logic (selection.ts)
 * - Navigation/history (navigation.ts)
 * - Clipboard (clipboard.svelte.ts) - shared between panes
 * - Dialogs (dialogs.svelte.ts) - global dialog state
 * - Context menu (context-menu.svelte.ts) - global context menu state
 * - Undo (undo.svelte.ts) - global undo stack
 */

import {
  fetchDirectory,
  createDirectory,
  renameEntry as apiRenameEntry,
  deleteEntry,
  deleteMultipleEntries,
  copyEntry,
  moveEntry,
  startStreamingDirectory,
  cancelDirectoryListing,
  extractListingId,
  type DirectoryEntriesEvent,
} from "$lib/api/files";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sortEntries, filterHidden, type FileEntry, type SortField } from "$lib/domain/file";
import type { SelectOptions, ViewMode } from "./types";
import * as selection from "./selection";
import * as navigation from "./navigation";
import { clipboardStore } from "./clipboard.svelte";
import { dialogStore } from "./dialogs.svelte";
import { recentFilesStore } from "./recent-files.svelte";
import { contextMenuStore } from "./context-menu.svelte";
import { undoStore } from "./undo.svelte";
import { settingsStore } from "./settings.svelte";

/** Per-directory sort preference persistence */
const SORT_STORAGE_KEY = "explorer-sort-prefs";
const MAX_SORT_ENTRIES = 200;

interface SortPref { sortBy: SortField; sortAscending: boolean; }

function loadSortPrefs(): Record<string, SortPref> {
  if (typeof localStorage === "undefined") return {};
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function saveSortPref(path: string, pref: SortPref): void {
  if (typeof localStorage === "undefined") return;
  const prefs = loadSortPrefs();
  prefs[path] = pref;
  // Evict oldest entries if over limit
  const keys = Object.keys(prefs);
  if (keys.length > MAX_SORT_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_SORT_ENTRIES)) {
      delete prefs[key];
    }
  }
  localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(prefs));
}

function getSortPref(path: string): SortPref | undefined {
  return loadSortPrefs()[path];
}

/** Core explorer state (per-pane) */
interface ExplorerCoreState {
  // Navigation
  currentPath: string;
  history: string[];
  historyIndex: number;

  // Entries
  entries: FileEntry[];
  loading: boolean;
  error: string | null;

  // View options (showHidden is in settingsStore, shared across panes)
  sortBy: SortField;
  sortAscending: boolean;
  viewMode: ViewMode;

  // Selection
  selectedPaths: Set<string>;
  selectionAnchorIndex: number | null;
}

function createExplorerState() {
  // Core per-pane state using $state rune
  let coreState = $state<ExplorerCoreState>({
    // Navigation
    currentPath: "",
    history: [],
    historyIndex: -1,

    // Entries
    entries: [],
    loading: false,
    error: null,

    // View options
    sortBy: "name",
    sortAscending: true,
    viewMode: "details",

    // Selection
    selectedPaths: new Set(),
    selectionAnchorIndex: null,
  });

  // Backward-compatible state accessor that includes global stores
  // This allows existing components to access dialog/context menu state via explorer.state
  const state = $derived({
    ...coreState,
    // Dialog state (from global dialogStore)
    newFolderDialogOpen: dialogStore.isNewFolderOpen,
    renamingEntry: dialogStore.renamingEntry,
    deletingEntry: dialogStore.deletingEntry,
    // Context menu state (from global contextMenuStore)
    contextMenuOpen: contextMenuStore.isOpen,
    contextMenuPosition: contextMenuStore.position,
  });

  // ===================
  // Derived State
  // ===================

  const displayEntries = $derived.by(() => {
    const filtered = filterHidden(coreState.entries, settingsStore.showHidden);
    return sortEntries(filtered, coreState.sortBy, coreState.sortAscending);
  });

  const breadcrumbs = $derived(navigation.parseBreadcrumbs(coreState.currentPath));
  const canGoBack = $derived(navigation.canGoBack(coreState.historyIndex));
  const canGoForward = $derived(navigation.canGoForward(coreState.history, coreState.historyIndex));
  const canUndo = $derived(undoStore.canUndo);
  const canRedo = $derived(undoStore.canRedo);

  // ===================
  // Streaming Directory State
  // ===================

  let activeListingId: number | null = null;
  let directoryUnlisten: UnlistenFn | null = null;

  async function cleanupDirectoryListener() {
    if (activeListingId !== null) {
      await cancelDirectoryListing(activeListingId);
      activeListingId = null;
    }
    if (directoryUnlisten) {
      directoryUnlisten();
      directoryUnlisten = null;
    }
  }

  async function setupDirectoryListener(listingId: number, expectedPath: string) {
    // Clean up any existing listener
    if (directoryUnlisten) {
      directoryUnlisten();
    }

    directoryUnlisten = await listen<DirectoryEntriesEvent>("directory-entries", (event) => {
      const payload = event.payload;

      // Only handle events for our active listing
      if (payload.listingId !== listingId || activeListingId !== listingId) {
        return;
      }

      // Verify this is for the correct path
      if (payload.path !== expectedPath) {
        return;
      }

      // Append new entries to existing list
      coreState.entries = [...coreState.entries, ...payload.entries];

      // Stop loading when done
      if (payload.done) {
        coreState.loading = false;
        activeListingId = null;
      }
    });
  }

  // ===================
  // Navigation Actions
  // ===================

  async function navigateInternal(path: string): Promise<boolean> {
    // Cancel any active listing from previous navigation
    await cleanupDirectoryListener();

    coreState.loading = true;
    coreState.error = null;

    // Use streaming directory listing for potentially large directories
    const result = await startStreamingDirectory(path);

    if (result.ok) {
      const { path: actualPath, listingId } = extractListingId(result.data.path);
      coreState.currentPath = actualPath;
      coreState.entries = [...result.data.entries];

      // Restore saved sort preference for this directory
      const savedSort = getSortPref(actualPath);
      if (savedSort) {
        coreState.sortBy = savedSort.sortBy;
        coreState.sortAscending = savedSort.sortAscending;
      }

      // If there's a listing ID, more entries will come via events
      if (listingId !== null) {
        activeListingId = listingId;
        await setupDirectoryListener(listingId, actualPath);
        // Keep loading true until all entries received
      } else {
        // Small directory - all entries received, done loading
        coreState.loading = false;
      }
      return true;
    } else {
      coreState.error = result.error;
      coreState.loading = false;
      return false;
    }
  }

  async function navigateTo(path: string) {
    const success = await navigateInternal(path);
    if (success) {
      const newHistory = navigation.pushToHistory(
        coreState.history,
        coreState.historyIndex,
        coreState.currentPath
      );
      coreState.history = newHistory.history;
      coreState.historyIndex = newHistory.historyIndex;

      // Track directory navigation in recent files
      const name = path.split("/").filter(Boolean).pop() || path;
      recentFilesStore.add(path, name, "directory");
    }
  }

  async function goBack() {
    const prevPath = navigation.getBackPath(coreState.history, coreState.historyIndex);
    if (!prevPath) return;
    const success = await navigateInternal(prevPath);
    if (success) {
      coreState.historyIndex--;
    }
  }

  async function goForward() {
    const nextPath = navigation.getForwardPath(coreState.history, coreState.historyIndex);
    if (!nextPath) return;
    const success = await navigateInternal(nextPath);
    if (success) {
      coreState.historyIndex++;
    }
  }

  function goUp() {
    const parentPath = navigation.getParentPath(breadcrumbs);
    if (parentPath) {
      navigateTo(parentPath);
    }
  }

  function refresh() {
    navigateInternal(coreState.currentPath);
  }

  // ===================
  // View Actions
  // ===================

  function toggleHidden() {
    settingsStore.toggleHidden();
  }

  function setSorting(by: SortField) {
    if (coreState.sortBy === by) {
      coreState.sortAscending = !coreState.sortAscending;
    } else {
      coreState.sortBy = by;
      coreState.sortAscending = true;
    }
    // Persist sort preference for this directory
    saveSortPref(coreState.currentPath, {
      sortBy: coreState.sortBy,
      sortAscending: coreState.sortAscending,
    });
  }

  function setViewMode(mode: ViewMode) {
    coreState.viewMode = mode;
  }

  // ===================
  // Selection Actions
  // ===================

  function selectEntry(entry: FileEntry, options: SelectOptions = {}) {
    const result = selection.calculateSelection(
      displayEntries,
      entry,
      coreState.selectedPaths,
      coreState.selectionAnchorIndex,
      options
    );
    coreState.selectedPaths = result.selectedPaths;
    coreState.selectionAnchorIndex = result.anchorIndex;
  }

  function clearSelection() {
    coreState.selectedPaths = new Set();
    coreState.selectionAnchorIndex = null;
  }

  function isSelected(entry: FileEntry): boolean {
    return coreState.selectedPaths.has(entry.path);
  }

  function getSelectedEntries(): FileEntry[] {
    return selection.getSelectedEntries(displayEntries, coreState.selectedPaths);
  }

  function selectByIndices(indices: number[], addToSelection: boolean = false) {
    coreState.selectedPaths = selection.selectByIndices(
      displayEntries,
      indices,
      coreState.selectedPaths,
      addToSelection
    );
  }

  function selectAll() {
    coreState.selectedPaths = new Set(displayEntries.map((e) => e.path));
    coreState.selectionAnchorIndex = 0;
  }

  // ===================
  // Dialog Actions (delegates to global dialogStore)
  // ===================

  function openNewFolderDialog() {
    dialogStore.openNewFolder();
  }

  function closeNewFolderDialog() {
    dialogStore.closeNewFolder();
  }

  function startRename(entry: FileEntry) {
    dialogStore.startRename(entry);
  }

  function cancelRename() {
    dialogStore.cancelRename();
  }

  function startDelete(entries: FileEntry | FileEntry[]) {
    const arr = Array.isArray(entries) ? entries : [entries];
    if (arr.length === 0) return;
    dialogStore.startDelete(arr);
  }

  function cancelDelete() {
    dialogStore.cancelDelete();
  }

  // ===================
  // Context Menu Actions (delegates to global contextMenuStore)
  // ===================

  function openContextMenu(x: number, y: number, entry?: FileEntry) {
    if (entry) {
      // If right-clicked entry is not selected, select only it
      if (!coreState.selectedPaths.has(entry.path)) {
        coreState.selectedPaths = new Set([entry.path]);
        const entryIndex = displayEntries.findIndex((e) => e.path === entry.path);
        coreState.selectionAnchorIndex = entryIndex;
      }
    }
    contextMenuStore.open(x, y);
  }

  function closeContextMenu() {
    contextMenuStore.close();
  }

  // ===================
  // File Operations
  // ===================

  async function createFolder(name: string): Promise<string | null> {
    if (!coreState.currentPath) return "No current directory";

    const result = await createDirectory(coreState.currentPath, name);

    if (result.ok) {
      coreState.entries = [...coreState.entries, result.data];
      dialogStore.closeNewFolder();
      return null;
    }
    return result.error;
  }

  async function rename(newName: string): Promise<string | null> {
    const renamingEntry = dialogStore.renamingEntry;
    if (!renamingEntry) return "No entry selected for rename";

    const oldName = renamingEntry.name;
    const oldPath = renamingEntry.path;
    const result = await apiRenameEntry(oldPath, newName);

    if (result.ok) {
      undoStore.push({ type: "rename", path: result.data.path, oldName, newName });
      coreState.entries = coreState.entries.map((e) => (e.path === oldPath ? result.data : e));
      dialogStore.cancelRename();
      return null;
    }
    return result.error;
  }

  async function confirmDelete(): Promise<string | null> {
    const entries = dialogStore.deletingEntries;
    if (entries.length === 0) return "No entries selected for delete";

    const paths = entries.map((e) => e.path);
    const result = entries.length === 1
      ? await deleteEntry(paths[0])
      : await deleteMultipleEntries(paths);

    if (result.ok) {
      const deletedPaths = new Set(paths);
      coreState.entries = coreState.entries.filter((e) => !deletedPaths.has(e.path));
      coreState.selectedPaths = new Set(
        [...coreState.selectedPaths].filter((p) => !deletedPaths.has(p))
      );
      dialogStore.cancelDelete();
      return null;
    }
    return result.error;
  }

  // ===================
  // Clipboard Actions (uses global clipboardStore for cross-pane support)
  // ===================

  async function copyToClipboard(entries: FileEntry[]) {
    await clipboardStore.copy(entries);
  }

  async function cutToClipboard(entries: FileEntry[]) {
    await clipboardStore.cut(entries);
  }

  function clearClipboard() {
    clipboardStore.clear();
  }

  async function paste(): Promise<string | null> {
    if (!coreState.currentPath) return "No current directory";

    // First check internal clipboard
    const clipboardContent = clipboardStore.content;

    if (clipboardContent) {
      const { entries, operation } = clipboardContent;
      const isCut = operation === "cut";
      const pasteOperation = isCut ? moveEntry : copyEntry;
      const errors: string[] = [];
      const newEntries: FileEntry[] = [];

      for (const entry of entries) {
        const originalDir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
        const result = await pasteOperation(entry.path, coreState.currentPath);

        if (result.ok) {
          newEntries.push(result.data);
          if (isCut) {
            undoStore.push({
              type: "move",
              sourcePath: entry.path,
              destPath: result.data.path,
              originalDir,
            });
          }
        } else {
          errors.push(`${entry.name}: ${result.error}`);
        }
      }

      if (isCut) clipboardStore.clear();
      if (newEntries.length > 0) {
        coreState.entries = [...coreState.entries, ...newEntries];
      }
      return errors.length > 0 ? `Failed: ${errors.join(", ")}` : null;
    }

    // Fall back to OS clipboard (files from external apps)
    const osContent = await clipboardStore.readOsFiles();
    if (!osContent || osContent.paths.length === 0) {
      return "Nothing in clipboard";
    }

    const errors: string[] = [];
    const newEntries: FileEntry[] = [];

    for (const sourcePath of osContent.paths) {
      const result = await copyEntry(sourcePath, coreState.currentPath);
      if (result.ok) {
        newEntries.push(result.data);
      } else {
        errors.push(`${sourcePath}: ${result.error}`);
      }
    }

    if (newEntries.length > 0) {
      coreState.entries = [...coreState.entries, ...newEntries];
    }

    return errors.length > 0 ? `Failed: ${errors.join(", ")}` : null;
  }

  // ===================
  // Undo Actions (delegates to global undoStore)
  // ===================

  async function undo(): Promise<string | null> {
    const error = await undoStore.undo();
    if (error) return error;

    // Refresh current directory to reflect undo
    await navigateInternal(coreState.currentPath);
    return null;
  }

  async function redo(): Promise<string | null> {
    const error = await undoStore.redo();
    if (error) return error;

    // Refresh current directory to reflect redo
    await navigateInternal(coreState.currentPath);
    return null;
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
    get canRedo() {
      return canRedo;
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
    setViewMode,
    // Selection
    selectEntry,
    clearSelection,
    isSelected,
    getSelectedEntries,
    selectByIndices,
    selectAll,
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
    // Undo/Redo
    undo,
    redo,
  };
}

/** Factory function for creating explorer instances (used for multi-pane) */
export { createExplorerState };

/** Type for the explorer instance */
export type ExplorerInstance = ReturnType<typeof createExplorerState>;

/** Default singleton explorer for single-pane mode */
export const explorer = createExplorerState();
