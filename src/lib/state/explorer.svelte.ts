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

import { toastStore } from "./toast.svelte";
import {
  createDirectory,
  renameEntry as apiRenameEntry,
  deleteEntry,
  deleteMultipleEntries,
  deleteEntryPermanent,
  clipboardHasImage,
  clipboardPasteImage,
  watchDirectory,
  unwatchDirectory,
} from "$lib/api/files";
import { broadcastFileChange } from "./file-events";
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
import { manualHiddenStore } from "./manual-hidden.svelte";
import { frecencyStore } from "./frecency.svelte";
import { getSortPref, saveSortPref } from "./sort-prefs";
import { pasteEntries, type PasteResult } from "./paste-operations";
import { createDirectoryListing } from "./directory-listing";
import { getAffectedDirs, undoActionLabel } from "./undo-helpers";

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

interface ExplorerSeed {
  currentPath: string;
  entries: FileEntry[];
  sortBy: SortField;
  sortAscending: boolean;
  viewMode: ViewMode;
}

function createExplorerState(seed?: ExplorerSeed) {
  // Core per-pane state using $state rune
  let coreState = $state<ExplorerCoreState>({
    // Navigation
    currentPath: seed?.currentPath ?? "",
    history: [],
    historyIndex: -1,

    // Entries
    entries: seed?.entries ?? [],
    loading: !seed, // not loading if seeded
    error: null,

    // View options
    sortBy: seed?.sortBy ?? "name",
    sortAscending: seed?.sortAscending ?? true,
    viewMode: seed?.viewMode ?? settingsStore.viewMode,

    // Selection
    selectedPaths: new Set(),
    selectionAnchorIndex: null,
  });

  // Inline folder creation state
  let isCreatingFolder = $state(false);

  // Filter query for filtering displayed entries (Ctrl+F)
  let filterQuery = $state("");
  let showFilter = $state(false);

  // Navigation callback for UI (e.g. focusing the selected item after nav)
  let onNavigateCallback: (() => void) | null = null;

  // Filesystem watcher: track which path this pane is watching
  let watchedPath: string | null = null;

  // Suppress redundant watcher refreshes after local mutations (delete/rename/create).
  // Local mutations already update coreState.entries; the watcher event that follows
  // would trigger an identical refresh causing all thumbnails to flash.
  const MUTATION_COOLDOWN_MS = 1000;
  let lastMutationTime = 0;

  function markLocalMutation(): void {
    lastMutationTime = Date.now();
  }

  function updateWatch(newPath: string) {
    if (watchedPath === newPath) return;
    if (watchedPath) unwatchDirectory(watchedPath);
    watchDirectory(newPath);
    watchedPath = newPath;
  }

  function destroyWatch() {
    if (watchedPath) {
      unwatchDirectory(watchedPath);
      watchedPath = null;
    }
  }

  // Read-only state accessor for components that need the raw state bag
  const state = $derived({ ...coreState });

  // ===================
  // Derived State
  // ===================

  const displayEntries = $derived.by(() => {
    let filtered = filterHidden(coreState.entries, settingsStore.showHidden);
    const manualHiddenNames = manualHiddenStore.namesIn(coreState.currentPath);
    if (manualHiddenNames.size > 0 && !settingsStore.showManuallyHidden) {
      filtered = filtered.filter((e) => !manualHiddenNames.has(e.name));
    }
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      filtered = filtered.filter((e) => e.name.toLowerCase().includes(q));
    }
    return sortEntries(filtered, coreState.sortBy, coreState.sortAscending);
  });

  const breadcrumbs = $derived(navigation.parseBreadcrumbs(coreState.currentPath));
  const canGoBack = $derived(navigation.canGoBack(coreState.historyIndex));
  const canGoForward = $derived(navigation.canGoForward(coreState.history, coreState.historyIndex));

  // ===================
  // Directory Listing
  // ===================

  const dirListing = createDirectoryListing();

  async function navigateInternal(path: string): Promise<boolean> {
    // If we already have entries for this path (e.g. seeded from another tab),
    // don't show loading state — the existing entries stay visible while we refresh.
    const isSeeded = coreState.currentPath === path && coreState.entries.length > 0;
    if (!isSeeded) {
      coreState.loading = true;
    }
    coreState.error = null;
    filterQuery = "";
    showFilter = false;

    const result = await dirListing.load(path, {
      onEntries: (entries) => {
        coreState.entries = [...coreState.entries, ...entries];
      },
      onDone: () => {
        coreState.loading = false;
      },
    });

    if (result.ok) {
      coreState.currentPath = result.path;
      coreState.entries = result.entries;
      updateWatch(result.path);

      const savedSort = getSortPref(result.path);
      if (savedSort) {
        coreState.sortBy = savedSort.sortBy;
        coreState.sortAscending = savedSort.sortAscending;
      }

      // Auto-select first item when navigating to a new directory
      // Issue: tauri-explorer-130a
      coreState.selectedPaths = new Set();
      if (displayEntries.length > 0) {
        coreState.selectedPaths = new Set([displayEntries[0].path]);
        coreState.selectionAnchorIndex = 0;
      } else {
        coreState.selectionAnchorIndex = null;
      }

      onNavigateCallback?.();

      if (!result.streaming) {
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

      // Track directory navigation in recent files and frecency
      const name = path.split("/").filter(Boolean).pop() || path;
      recentFilesStore.add(path, name, "directory");
      frecencyStore.recordAccess(path);
    }
  }

  async function goBack() {
    const prevPath = navigation.getBackPath(coreState.history, coreState.historyIndex);
    if (!prevPath) return;
    const success = await navigateInternal(prevPath);
    if (success) {
      coreState.historyIndex--;
    } else {
      // Path no longer exists — fall back to parent
      const parentPath = navigation.getParentPath(breadcrumbs);
      if (parentPath) await navigateInternal(parentPath);
    }
  }

  async function goForward() {
    const nextPath = navigation.getForwardPath(coreState.history, coreState.historyIndex);
    if (!nextPath) return;
    const success = await navigateInternal(nextPath);
    if (success) {
      coreState.historyIndex++;
    } else {
      // Path no longer exists — fall back to parent
      const parentPath = navigation.getParentPath(breadcrumbs);
      if (parentPath) await navigateInternal(parentPath);
    }
  }

  function goUp() {
    const parentPath = navigation.getParentPath(breadcrumbs);
    if (parentPath) {
      navigateTo(parentPath);
    }
  }

  /** Build a fingerprint string for change detection. */
  function entriesFingerprint(entries: FileEntry[]): string {
    return entries.map((e) => `${e.path}\0${e.size}\0${e.modified}`).join("\n");
  }

  async function refresh(options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;

    // Skip watcher-triggered refreshes during the cooldown after local mutations.
    // The local mutation already updated entries; refetching would replace entry
    // objects and cause thumbnail components to flash/reload.
    if (silent && Date.now() - lastMutationTime < MUTATION_COOLDOWN_MS) {
      return;
    }

    const oldFingerprint = entriesFingerprint(coreState.entries);

    // Fetch new data without touching UI state — avoids flash on no-change
    const result = await dirListing.load(coreState.currentPath, {
      onEntries: () => {},
      onDone: () => {},
    });

    if (!result.ok) {
      // Directory no longer exists — fall back to parent
      const parentPath = navigation.getParentPath(breadcrumbs);
      if (parentPath) {
        await navigateInternal(parentPath);
      }
      return;
    }

    const newFingerprint = entriesFingerprint(result.entries);
    // Compare against both the pre-fetch snapshot and the current entries.
    // A local mutation may have updated entries while the fetch was in flight
    // (inotify on Linux fires before the IPC response returns).
    const currentFingerprint = entriesFingerprint(coreState.entries);
    if (oldFingerprint === newFingerprint || currentFingerprint === newFingerprint) {
      if (!silent) {
        toastStore.show("Already up to date", "info", { duration: 1500 });
      }
      return;
    }

    coreState.entries = result.entries;
    updateWatch(result.path);

    if (!result.streaming) {
      coreState.loading = false;
    }

    if (!silent) {
      toastStore.show("Refreshed", "info", { duration: 1500 });
    }
  }

  // ===================
  // View Actions
  // ===================

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
    settingsStore.setViewMode(mode);
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
    const nextSet = selection.selectByIndices(
      displayEntries,
      indices,
      coreState.selectedPaths,
      addToSelection,
    );
    // selection.selectByIndices returns the same reference when nothing changed
    if (nextSet === coreState.selectedPaths) return;
    coreState.selectedPaths = nextSet;
  }

  function selectAll() {
    coreState.selectedPaths = new Set(displayEntries.map((e) => e.path));
    coreState.selectionAnchorIndex = 0;
  }

  // ===================
  // Dialog & Context Menu Actions
  // ===================

  async function navigateAwayIfNeeded(deletedPaths: Set<string>): Promise<void> {
    const current = coreState.currentPath;
    const shouldNavigateAway = [...deletedPaths].some(
      (dp) => current === dp || current.startsWith(dp + "/")
    );
    if (shouldNavigateAway) {
      const parentPath = navigation.getParentPath(breadcrumbs);
      if (parentPath) await navigateTo(parentPath);
    }
  }

  async function startDelete(entries: FileEntry | FileEntry[]) {
    const arr = Array.isArray(entries) ? entries : [entries];
    if (arr.length === 0) return;

    if (!settingsStore.confirmDelete) {
      const paths = arr.map((e) => e.path);
      markLocalMutation();
      const result = arr.length === 1
        ? await deleteEntry(paths[0])
        : await deleteMultipleEntries(paths);

      if (result.ok) {
        undoStore.push({ type: "delete", paths, parentDir: coreState.currentPath });
        const deletedPaths = new Set(paths);
        coreState.entries = coreState.entries.filter((e) => !deletedPaths.has(e.path));
        coreState.selectedPaths = new Set(
          [...coreState.selectedPaths].filter((p) => !deletedPaths.has(p))
        );
        markLocalMutation();
        await navigateAwayIfNeeded(deletedPaths);
        frecencyStore.pruneNonExistent();
      }
      return;
    }

    dialogStore.startDelete(arr);
  }

  /** Start permanent delete — always shows confirmation dialog. */
  function startPermanentDelete(entries: FileEntry | FileEntry[]) {
    const arr = Array.isArray(entries) ? entries : [entries];
    if (arr.length === 0) return;
    dialogStore.startDelete(arr, true);
  }

  function openContextMenu(x: number, y: number, entry?: FileEntry) {
    if (entry && !coreState.selectedPaths.has(entry.path)) {
      coreState.selectedPaths = new Set([entry.path]);
      coreState.selectionAnchorIndex = displayEntries.findIndex((e) => e.path === entry.path);
    }
    contextMenuStore.open(x, y);
  }

  // ===================
  // File Operations
  // ===================

  async function createFolder(name: string): Promise<string | null> {
    if (!coreState.currentPath) return "No current directory";

    markLocalMutation();
    const result = await createDirectory(coreState.currentPath, name);

    if (result.ok) {
      coreState.entries = [...coreState.entries, result.data];
      coreState.selectedPaths = new Set([result.data.path]);
      const idx = displayEntries.findIndex((e) => e.path === result.data.path);
      coreState.selectionAnchorIndex = idx >= 0 ? idx : null;
      isCreatingFolder = false;
      markLocalMutation();
      dialogStore.closeNewFolder();
      broadcastFileChange([coreState.currentPath]);
      return null;
    }
    return result.error;
  }

  /** Start inline folder creation (shows editable placeholder in file list) */
  function startInlineNewFolder(): void {
    isCreatingFolder = true;
  }

  /** Cancel inline folder creation */
  function cancelInlineNewFolder(): void {
    isCreatingFolder = false;
  }

  async function rename(newName: string): Promise<string | null> {
    const renamingEntry = dialogStore.renamingEntry;
    if (!renamingEntry) return "No entry selected for rename";

    const oldName = renamingEntry.name;
    const oldPath = renamingEntry.path;
    markLocalMutation();
    const result = await apiRenameEntry(oldPath, newName);

    if (result.ok) {
      undoStore.push({ type: "rename", path: result.data.path, oldName, newName });
      coreState.entries = coreState.entries.map((e) => (e.path === oldPath ? result.data : e));
      clipboardStore.updatePath(oldPath, result.data);
      markLocalMutation();
      dialogStore.cancelRename();
      frecencyStore.pruneNonExistent();
      return null;
    }
    return result.error;
  }

  async function confirmDelete(
    entriesArg?: readonly FileEntry[],
    isPermanentArg?: boolean,
  ): Promise<string | null> {
    const entries = entriesArg ?? dialogStore.deletingEntries;
    if (entries.length === 0) return "No entries selected for delete";
    const isPermanent = isPermanentArg ?? dialogStore.isPermanentDelete;

    const paths = entries.map((e) => e.path);
    let result: { ok: boolean; error?: string };

    markLocalMutation();
    if (isPermanent) {
      const errors: string[] = [];
      for (const path of paths) {
        const r = await deleteEntryPermanent(path);
        if (!r.ok) errors.push(r.error);
      }
      result = errors.length > 0 ? { ok: false, error: errors.join("; ") } : { ok: true };
    } else {
      result = entries.length === 1
        ? await deleteEntry(paths[0])
        : await deleteMultipleEntries(paths);
    }

    if (result.ok) {
      if (!isPermanent) {
        undoStore.push({ type: "delete", paths, parentDir: coreState.currentPath });
      }
      const deletedPaths = new Set(paths);
      coreState.entries = coreState.entries.filter((e) => !deletedPaths.has(e.path));
      coreState.selectedPaths = new Set(
        [...coreState.selectedPaths].filter((p) => !deletedPaths.has(p))
      );
      markLocalMutation();
      dialogStore.cancelDelete();
      await navigateAwayIfNeeded(deletedPaths);
      frecencyStore.pruneNonExistent();
      return null;
    }
    return result.error ?? "Unknown error";
  }

  // ===================
  // Clipboard Actions (uses global clipboardStore for cross-pane support)
  // ===================

  async function copyToClipboard(entries: FileEntry[]) {
    await clipboardStore.copy(entries);
    const label = entries.length === 1 ? entries[0].name : `${entries.length} items`;
    toastStore.clipboard(`Copied: ${label}`, false);
  }

  async function cutToClipboard(entries: FileEntry[]) {
    await clipboardStore.cut(entries);
    const label = entries.length === 1 ? entries[0].name : `${entries.length} items`;
    toastStore.clipboard(`Cut: ${label}`, true);
  }

  // Paste result for UI feedback
  let pasteResult = $state<PasteResult | null>(null);

  function makePasteContext() {
    let pastedPaths: Set<string> | null = null;
    return {
      destPath: coreState.currentPath,
      existingEntries: coreState.entries,
      onEntriesAdded: (entries: FileEntry[]) => {
        coreState.entries = [...coreState.entries, ...entries];
        markLocalMutation();
        // Remember pasted paths so onRefresh can re-select after navigation
        if (entries.length > 0) {
          pastedPaths = new Set(entries.map((e) => e.path));
          coreState.selectedPaths = pastedPaths;
        }
      },
      onRefresh: async () => {
        await navigateInternal(coreState.currentPath);
        // Re-select pasted entries after refresh resets selection
        if (pastedPaths) {
          coreState.selectedPaths = pastedPaths;
          pastedPaths = null;
        }
      },
    };
  }

  async function paste(): Promise<string | null> {
    if (!coreState.currentPath) return "No current directory";

    // First check internal clipboard
    const clipboardContent = clipboardStore.content;

    if (clipboardContent) {
      const { entries, operation } = clipboardContent;
      const isCut = operation === "cut";
      markLocalMutation();
      const error = await pasteEntries(
        entries.map((e) => ({ path: e.path, name: e.name, size: e.size, modified: e.modified })),
        isCut,
        makePasteContext(),
        () => { if (isCut) clipboardStore.clear(); },
      );
      pasteResult = { error, timestamp: Date.now() };
      return error;
    }

    // Fall back to OS clipboard (files from external apps)
    const osContent = await clipboardStore.readOsFiles();
    if (osContent && osContent.paths.length > 0) {
      markLocalMutation();
      const error = await pasteEntries(
        osContent.paths.map((p) => ({ path: p, name: p.split(/[/\\]/).pop() || p })),
        false,
        makePasteContext(),
      );
      pasteResult = { error, timestamp: Date.now() };
      return error;
    }

    // Fall back to clipboard image
    if (await clipboardHasImage()) {
      markLocalMutation();
      const result = await clipboardPasteImage(coreState.currentPath);
      if (result.ok) {
        markLocalMutation();
        await navigateInternal(coreState.currentPath);
        return null;
      }
      return result.error;
    }

    return "Nothing in clipboard";
  }

  // ===================
  // Undo Actions
  // ===================

  async function undo(): Promise<string | null> {
    markLocalMutation();
    const result = await undoStore.undo();
    if ("error" in result) return result.error;

    toastStore.show(`Undo: ${undoActionLabel(result.action)}`, "info");
    markLocalMutation();
    await navigateInternal(coreState.currentPath);
    broadcastFileChange(getAffectedDirs(result.action));
    return null;
  }

  async function redo(): Promise<string | null> {
    markLocalMutation();
    const result = await undoStore.redo();
    if ("error" in result) return result.error;

    toastStore.show(`Redo: ${undoActionLabel(result.action)}`, "info");
    markLocalMutation();
    await navigateInternal(coreState.currentPath);
    broadcastFileChange(getAffectedDirs(result.action));
    return null;
  }

  // ===================
  // Public API
  // ===================

  return {
    // Raw state bag (prefer top-level getters below)
    get state() {
      return state;
    },

    // Top-level state getters (preferred over state.*)
    get currentPath() {
      return coreState.currentPath;
    },
    get loading() {
      return coreState.loading;
    },
    get error() {
      return coreState.error;
    },
    get viewMode() {
      return coreState.viewMode;
    },
    get sortBy() {
      return coreState.sortBy;
    },
    get sortAscending() {
      return coreState.sortAscending;
    },
    get selectedPaths() {
      return coreState.selectedPaths;
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

    // Navigation
    navigateTo,
    goBack,
    goForward,
    goUp,
    refresh,
    // View
    setSorting,
    setViewMode,
    // Filter
    get filterQuery() { return filterQuery; },
    get showFilter() { return showFilter; },
    toggleFilter() {
      showFilter = !showFilter;
      if (!showFilter) filterQuery = "";
    },
    openFilter() { showFilter = true; },
    closeFilter() { showFilter = false; filterQuery = ""; },
    setFilter(query: string) {
      filterQuery = query;
      // Auto-select the first matching entry as the user types
      const first = displayEntries[0];
      if (first) {
        coreState.selectedPaths = new Set([first.path]);
        coreState.selectionAnchorIndex = 0;
      } else {
        coreState.selectedPaths = new Set();
        coreState.selectionAnchorIndex = null;
      }
    },
    clearFilter() { filterQuery = ""; },
    // Selection
    selectEntry,
    clearSelection,
    isSelected,
    getSelectedEntries,
    selectByIndices,
    selectAll,
    // Dialogs
    startRename: (entry: FileEntry) => dialogStore.startRename(entry),
    startDelete,
    startPermanentDelete,
    // Context menu
    openContextMenu,
    // Inline folder creation
    get isCreatingFolder() {
      return isCreatingFolder;
    },
    startInlineNewFolder,
    cancelInlineNewFolder,
    // File operations
    createFolder,
    rename,
    confirmDelete,
    // Clipboard
    copyToClipboard,
    cutToClipboard,
    paste,
    get pasteResult() {
      return pasteResult;
    },
    // Undo/Redo
    undo,
    redo,
    // Navigation callback
    set onNavigate(cb: (() => void) | null) {
      onNavigateCallback = cb;
    },
    // Cleanup
    destroy: destroyWatch,
  };
}

/** Factory function for creating explorer instances (used for multi-pane) */
export { createExplorerState };

/** Type for the explorer instance */
export type ExplorerInstance = ReturnType<typeof createExplorerState>;
