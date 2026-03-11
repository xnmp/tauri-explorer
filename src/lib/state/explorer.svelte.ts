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
import { loadPersisted, savePersisted } from "./persisted";
import {
  fetchDirectory,
  createDirectory,
  renameEntry as apiRenameEntry,
  deleteEntry,
  deleteMultipleEntries,
  copyEntry,
  moveEntry,
  estimateSize,
  startStreamingDirectory,
  cancelDirectoryListing,
  clipboardHasImage,
  clipboardPasteImage,
  type DirectoryEntriesEvent,
} from "$lib/api/files";
import { operationsManager } from "./operations.svelte";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { broadcastFileChange } from "./file-events";
import { conflictResolver, type ConflictChoice } from "./conflict-resolver.svelte";
import { sortEntries, filterHidden, type FileEntry, type SortField } from "$lib/domain/file";
import type { SelectOptions, ViewMode, UndoAction } from "./types";
import * as selection from "./selection";
import * as navigation from "./navigation";
import { clipboardStore } from "./clipboard.svelte";
import { dialogStore } from "./dialogs.svelte";
import { recentFilesStore } from "./recent-files.svelte";
import { contextMenuStore } from "./context-menu.svelte";
import { undoStore } from "./undo.svelte";
import { settingsStore } from "./settings.svelte";
import { frecencyStore } from "./frecency.svelte";

/** Per-directory sort preference persistence */
const SORT_STORAGE_KEY = "explorer-sort-prefs";
const MAX_SORT_ENTRIES = 200;

interface SortPref { sortBy: SortField; sortAscending: boolean; }

function loadSortPrefs(): Record<string, SortPref> {
  return loadPersisted(SORT_STORAGE_KEY, {});
}

function saveSortPref(path: string, pref: SortPref): void {
  const prefs = loadSortPrefs();
  prefs[path] = pref;
  // Evict oldest entries if over limit
  const keys = Object.keys(prefs);
  if (keys.length > MAX_SORT_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_SORT_ENTRIES)) {
      delete prefs[key];
    }
  }
  savePersisted(SORT_STORAGE_KEY, prefs);
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
    viewMode: settingsStore.viewMode,

    // Selection
    selectedPaths: new Set(),
    selectionAnchorIndex: null,
  });

  // Inline folder creation state
  let isCreatingFolder = $state(false);

  // Read-only state accessor for components that need the raw state bag
  const state = $derived({ ...coreState });

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
      coreState.currentPath = result.data.path;
      const listingId = result.data.listing_id;
      coreState.entries = [...result.data.entries];

      // Restore saved sort preference for this directory
      const savedSort = getSortPref(result.data.path);
      if (savedSort) {
        coreState.sortBy = savedSort.sortBy;
        coreState.sortAscending = savedSort.sortAscending;
      }

      // If there's a listing ID, more entries will come via events
      if (listingId !== null) {
        activeListingId = listingId;
        await setupDirectoryListener(listingId, result.data.path);
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

  async function refresh() {
    const success = await navigateInternal(coreState.currentPath);
    if (!success) {
      // Current path no longer exists (e.g. was deleted) — fall back to parent
      const parentPath = navigation.getParentPath(breadcrumbs);
      if (parentPath) {
        await navigateInternal(parentPath);
      }
    }
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

  /** If any deleted path is the current directory or an ancestor, navigate up. */
  async function navigateAwayIfNeeded(deletedPaths: Set<string>): Promise<void> {
    const current = coreState.currentPath;
    const shouldNavigateAway = [...deletedPaths].some(
      (dp) => current === dp || current.startsWith(dp + "/")
    );
    if (shouldNavigateAway) {
      // Navigate to the parent of the current directory
      const parentPath = navigation.getParentPath(breadcrumbs);
      if (parentPath) {
        await navigateTo(parentPath);
      }
    }
  }

  async function startDelete(entries: FileEntry | FileEntry[]) {
    const arr = Array.isArray(entries) ? entries : [entries];
    if (arr.length === 0) return;

    if (!settingsStore.confirmDelete) {
      // Skip dialog, delete immediately
      const paths = arr.map((e) => e.path);
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
        await navigateAwayIfNeeded(deletedPaths);
      }
      return;
    }

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
      coreState.selectedPaths = new Set([result.data.path]);
      const idx = displayEntries.findIndex((e) => e.path === result.data.path);
      coreState.selectionAnchorIndex = idx >= 0 ? idx : null;
      isCreatingFolder = false;
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
    const result = await apiRenameEntry(oldPath, newName);

    if (result.ok) {
      undoStore.push({ type: "rename", path: result.data.path, oldName, newName });
      coreState.entries = coreState.entries.map((e) => (e.path === oldPath ? result.data : e));
      // Update clipboard if renamed file was in it (fixes stale path after rename)
      clipboardStore.updatePath(oldPath, result.data);
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
      undoStore.push({ type: "delete", paths, parentDir: coreState.currentPath });
      const deletedPaths = new Set(paths);
      coreState.entries = coreState.entries.filter((e) => !deletedPaths.has(e.path));
      coreState.selectedPaths = new Set(
        [...coreState.selectedPaths].filter((p) => !deletedPaths.has(p))
      );
      dialogStore.cancelDelete();
      await navigateAwayIfNeeded(deletedPaths);
      return null;
    }
    return result.error;
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

  function clearClipboard() {
    clipboardStore.clear();
  }

  // Paste result for UI feedback
  let pasteResult = $state<{ error: string | null; timestamp: number } | null>(null);

  async function paste(): Promise<string | null> {
    if (!coreState.currentPath) return "No current directory";

    // First check internal clipboard
    const clipboardContent = clipboardStore.content;

    if (clipboardContent) {
      const { entries, operation } = clipboardContent;
      const isCut = operation === "cut";
      return pasteEntries(
        entries.map((e) => ({ path: e.path, name: e.name })),
        isCut,
        () => { if (isCut) clipboardStore.clear(); },
      );
    }

    // Fall back to OS clipboard (files from external apps)
    const osContent = await clipboardStore.readOsFiles();
    if (osContent && osContent.paths.length > 0) {
      return pasteEntries(
        osContent.paths.map((p) => ({ path: p, name: p.split(/[/\\]/).pop() || p })),
        false,
      );
    }

    // Fall back to clipboard image
    if (await clipboardHasImage()) {
      const result = await clipboardPasteImage(coreState.currentPath);
      if (result.ok) {
        await navigateInternal(coreState.currentPath);
        return null;
      }
      return result.error;
    }

    return "Nothing in clipboard";
  }

  /** Core paste logic with progress tracking and conflict resolution */
  async function pasteEntries(
    sources: { path: string; name: string }[],
    isCut: boolean,
    onComplete?: () => void,
  ): Promise<string | null> {
    const destPath = coreState.currentPath;
    const opType = isCut ? "move" as const : "copy" as const;
    const label = sources.length === 1 ? sources[0].name : `${sources.length} items`;

    // Estimate total size for byte-level progress
    const sizeResult = await estimateSize(sources.map((s) => s.path));
    const totalBytes = sizeResult.ok ? sizeResult.data.totalBytes : 0;

    // Start tracking operation in progress dialog
    const op = operationsManager.startOperation(opType, label, destPath);

    const errors: string[] = [];
    const newEntries: FileEntry[] = [];
    let bytesProcessed = 0;
    let cancelledByUser = false;

    // Detect conflicts: which source names already exist in destination
    const existingNames = new Set(coreState.entries.map((e) => e.name));
    let globalChoice: ConflictChoice | null = null;

    for (let i = 0; i < sources.length; i++) {
      // Check cancellation between files
      if (operationsManager.isOperationCancelled(op.id)) break;

      const source = sources[i];
      const sourceDir = source.path.substring(0, source.path.lastIndexOf("/")) || "/";

      // When cutting from the same directory, the file isn't a real conflict
      const isSameDir = isCut && sourceDir === destPath;
      const hasConflict = !isSameDir && existingNames.has(source.name);
      let overwrite = false;

      if (hasConflict) {
        if (globalChoice === "skip") continue;
        if (globalChoice === "cancel") { cancelledByUser = true; break; }
        if (globalChoice === "overwrite") {
          overwrite = true;
        } else {
          const remaining = sources.length - i - 1;
          const { choice, applyToAll } = await conflictResolver.prompt({
            fileName: source.name,
            sourcePath: source.path,
            remaining,
          });
          if (applyToAll) globalChoice = choice;
          if (choice === "skip") continue;
          if (choice === "cancel") { cancelledByUser = true; break; }
          if (choice === "overwrite") overwrite = true;
        }
      }

      // Skip no-op: cut-paste to same directory (file is already there)
      if (isSameDir) {
        newEntries.push(coreState.entries.find((e) => e.name === source.name)!);
      } else {
        const result = isCut
          ? await moveEntry(source.path, destPath, overwrite)
          : await copyEntry(source.path, destPath, overwrite);

        if (result.ok) {
          newEntries.push(result.data);
          if (isCut) {
            undoStore.push({
              type: "move",
              sourcePath: source.path,
              destPath: result.data.path,
              originalDir: sourceDir,
            });
          }
        } else {
          errors.push(`${source.name}: ${result.error}`);
        }
      }

      // Update progress (file-level granularity)
      if (totalBytes > 0) {
        bytesProcessed = Math.round(totalBytes * ((i + 1) / sources.length));
        operationsManager.updateProgress(
          op.id,
          ((i + 1) / sources.length) * 100,
          bytesProcessed,
          totalBytes,
        );
      } else {
        operationsManager.updateProgress(op.id, ((i + 1) / sources.length) * 100);
      }
    }

    onComplete?.();

    // Finalize operation tracking
    if (operationsManager.isOperationCancelled(op.id) || cancelledByUser) {
      operationsManager.cancelOperation(op.id);
    } else if (errors.length > 0 && newEntries.length === 0) {
      operationsManager.failOperation(op.id, errors.join("; "));
    } else {
      operationsManager.completeOperation(op.id);
    }

    if (newEntries.length > 0) {
      coreState.entries = [...coreState.entries, ...newEntries];
      const affectedDirs = new Set([destPath]);
      for (const source of sources) {
        const dir = source.path.substring(0, source.path.lastIndexOf("/")) || "/";
        affectedDirs.add(dir);
      }
      broadcastFileChange([...affectedDirs]);
    }

    await navigateInternal(destPath);
    const error = errors.length > 0 ? `Failed: ${errors.join(", ")}` : null;
    pasteResult = { error, timestamp: Date.now() };
    if (error) { toastStore.error(error); } else if (!operationsManager.isOperationCancelled(op.id)) { toastStore.success("Pasted successfully"); }
    return error;
  }

  // ===================
  // Undo Actions (delegates to global undoStore)
  // ===================

  /** Compute directories affected by an undo/redo action for broadcasting. */
  function getAffectedDirs(action: UndoAction): string[] {
    switch (action.type) {
      case "rename":
        return [action.path.substring(0, action.path.lastIndexOf("/"))];
      case "move":
        return [action.originalDir, action.destPath.substring(0, action.destPath.lastIndexOf("/"))];
      case "delete":
        return [action.parentDir];
    }
  }

  function undoActionLabel(action: UndoAction): string {
    switch (action.type) {
      case "rename": return `Renamed ${action.oldName}`;
      case "move": return `Moved to ${action.destPath.split("/").pop()}`;
      case "delete": return `Deleted ${action.paths.length} item${action.paths.length > 1 ? "s" : ""}`;
    }
  }

  async function undo(): Promise<string | null> {
    const result = await undoStore.undo();
    if ("error" in result) return result.error;

    toastStore.show(`Undo: ${undoActionLabel(result.action)}`, "info");
    await navigateInternal(coreState.currentPath);
    broadcastFileChange(getAffectedDirs(result.action));
    return null;
  }

  async function redo(): Promise<string | null> {
    const result = await undoStore.redo();
    if ("error" in result) return result.error;

    toastStore.show(`Redo: ${undoActionLabel(result.action)}`, "info");
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
    clearClipboard,
    paste,
    get pasteResult() {
      return pasteResult;
    },
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
