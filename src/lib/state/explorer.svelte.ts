/**
 * Explorer state management using Svelte 5 runes.
 * Issue: tauri-explorer-gcl, tauri-explorer-jql, tauri-explorer-h3n, tauri-explorer-x25, tauri-explorer-bhw5, tauri-explorer-u7bg, tauri-explorer-1k9k
 *
 * This store owns per-pane core state (path/history/entries/selection/
 * sort/view) and navigation. Supporting concerns live in extracted modules:
 * - Types (types.ts)
 * - Selection logic (selection.ts)
 * - Navigation/history (navigation.ts)
 * - Filesystem watch + mutation cooldown (pane-watch.ts)
 * - Refresh lifecycle (pane-refresh.ts)
 * - File mutations: create/rename/delete/symlink/archive (pane-mutations.ts)
 * - Clipboard (clipboard.svelte.ts) - shared between panes
 * - Dialogs (dialogs.svelte.ts) - global dialog state
 * - Context menu (context-menu.svelte.ts) - global context menu state
 * - Undo (undo.svelte.ts) - global undo stack
 */

import { toastStore } from "./toast.svelte";
import { basename, toNativeSeparators } from "$lib/domain/path";
import { isWindows } from "$lib/domain/platform";
import { clipboardHasImage, clipboardPasteImage, fetchDirectory } from "$lib/api/files";
import { sortEntries, filterHidden, type FileEntry, type SortField } from "$lib/domain/file";
import type { ExplorerCoreState, SelectOptions, ViewMode } from "./types";
import * as selection from "./selection";
import * as navigation from "./navigation";
import { clipboardStore } from "./clipboard.svelte";
import { dialogStore } from "./dialogs.svelte";
import { recentFilesStore } from "./recent-files.svelte";
import { contextMenuStore } from "./context-menu.svelte";
import { undoStore } from "./undo.svelte";
import { settingsStore } from "./settings.svelte";
import { manualHiddenStore } from "./manual-hidden.svelte";
import { getSortPref, saveSortPref } from "./sort-prefs";
import { pasteEntries, type PasteResult } from "./paste-operations";
import { createDirectoryListing } from "./directory-listing";
import { createPaneWatch } from "./pane-watch";
import { createPaneRefresh } from "./pane-refresh";
import { createPaneMutations } from "./pane-mutations";
import { getAffectedDirs, undoActionLabel } from "./undo-helpers";
import { broadcastFileChange } from "./file-events";

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

  // True when the current path lives on a removable drive that has been
  // ejected/unplugged. Set by ExplorerPane, which watches the drives store.
  let driveGone = $state(false);

  // Filter query for filtering displayed entries (Ctrl+F)
  let filterQuery = $state("");
  let showFilter = $state(false);

  // Navigation callback for UI (e.g. focusing the selected item after nav)
  let onNavigateCallback: (() => void) | null = null;

  // Filesystem watcher + local-mutation cooldown
  const watch = createPaneWatch();
  const markLocalMutation = watch.markLocalMutation;

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
    // Only Details view exposes sortable column headers. List and Tiles have no
    // sort UI, so they always sort by name ascending for a predictable order
    // regardless of the per-folder sort preference set in Details view.
    if (coreState.viewMode === "details") {
      return sortEntries(filtered, coreState.sortBy, coreState.sortAscending);
    }
    return sortEntries(filtered, "name", true);
  });

  const breadcrumbs = $derived(navigation.parseBreadcrumbs(coreState.currentPath));
  const canGoBack = $derived(navigation.canGoBack(coreState.historyIndex));
  const canGoForward = $derived(navigation.canGoForward(coreState.history, coreState.historyIndex));

  // ===================
  // Directory Listing
  // ===================

  const dirListing = createDirectoryListing();

  // Per-pane navigation generation counter. Guards against rapid A→B
  // navigation applying whichever result happens to land last.
  let navGeneration = 0;

  async function navigateInternal(rawPath: string): Promise<"ok" | "error" | "stale"> {
    // Normalize separators to the platform-native style up front. The backend
    // echoes the requested path back verbatim as `currentPath`, so this is the
    // single chokepoint that keeps the address bar (and everything that records
    // `currentPath`) consistent — never mixed `C:\Users\x/Pictures`. Gated to
    // `/` on non-Windows, where a backslash is a legal filename character.
    const path = toNativeSeparators(rawPath, isWindows ? "\\" : "/");
    const gen = ++navGeneration;

    // If we already have entries for this path (e.g. seeded from another tab),
    // don't show loading state — the existing entries stay visible while we refresh.
    const isSeeded = coreState.currentPath === path && coreState.entries.length > 0;
    if (!isSeeded) {
      coreState.loading = true;
    }
    coreState.error = null;
    filterQuery = "";
    showFilter = false;

    // Accumulate streamed continuation batches off the reactive graph. Writing
    // `coreState.entries = [...coreState.entries, ...batch]` per batch is O(n^2):
    // each write copies the growing array AND re-runs the `displayEntries`
    // filter+sort over everything so far (~50 full re-sorts for a 5000-entry
    // dir). Instead we push into a private buffer and commit a snapshot on a
    // throttle (preserving progressive fill-in) plus once at done. See
    // docs/perf-review.md findings #1/#2. The buffer seeds from the wholesale
    // `result.entries` assignment below, which always runs before the first
    // streaming callback (the continuation between them is synchronous).
    const FLUSH_INTERVAL_MS = 100;
    let streamBuffer: FileEntry[] | null = null;
    let pendingFlush: ReturnType<typeof setTimeout> | null = null;

    const commitBuffer = () => {
      pendingFlush = null;
      if (gen !== navGeneration || streamBuffer === null) return;
      coreState.entries = streamBuffer.slice();
    };

    const result = await dirListing.load(path, {
      onEntries: (entries) => {
        if (gen !== navGeneration) return;
        if (streamBuffer === null) streamBuffer = coreState.entries.slice();
        for (const e of entries) streamBuffer.push(e);
        if (pendingFlush === null) {
          pendingFlush = setTimeout(commitBuffer, FLUSH_INTERVAL_MS);
        }
      },
      onDone: () => {
        if (gen !== navGeneration) return;
        if (pendingFlush !== null) {
          clearTimeout(pendingFlush);
          pendingFlush = null;
        }
        if (streamBuffer !== null) {
          coreState.entries = streamBuffer.slice();
        }
        coreState.loading = false;
      },
    });

    // A newer navigation started while this one was in flight — discard.
    if (gen !== navGeneration) return "stale";

    if (result.ok) {
      coreState.currentPath = result.path;
      coreState.entries = result.entries;
      watch.update(result.path);

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
      return "ok";
    } else {
      coreState.error = result.error;
      coreState.loading = false;
      return "error";
    }
  }

  /** Navigate and push to history. Returns true on success. */
  async function applyNavigation(path: string): Promise<boolean> {
    const status = await navigateInternal(path);
    if (status !== "ok") return false;
    const newHistory = navigation.pushToHistory(
      coreState.history,
      coreState.historyIndex,
      coreState.currentPath
    );
    coreState.history = newHistory.history;
    coreState.historyIndex = newHistory.historyIndex;
    return true;
  }

  /**
   * Navigate to a directory.
   *
   * `autoEnterSingleSubdir` (default true) controls whether the "auto-enter
   * single subfolder" setting applies to this navigation. Breadcrumb/ancestor
   * navigation passes `false`: jumping to an ancestor only to immediately
   * descend back through single-child folders would defeat the point of going
   * up.
   */
  async function navigateTo(
    path: string,
    options: { autoEnterSingleSubdir?: boolean } = {}
  ) {
    const { autoEnterSingleSubdir = true } = options;

    // Resolve the "auto-enter single subfolder" descent BEFORE committing any
    // navigation. Peeking at the directory listings without touching pane state
    // means the intermediate single-child folders never render — the view jumps
    // straight to the final destination in one step (no flashing). The single
    // applyNavigation below pushes exactly one history entry, so Back still
    // undoes the whole jump in one press.
    let target = path;
    let skipped = 0;
    if (autoEnterSingleSubdir && settingsStore.autoEnterSingleSubdir) {
      const descent = await resolveAutoEnterTarget(path);
      target = descent.path;
      skipped = descent.skipped;
    }

    const success = await applyNavigation(target);
    if (success) {
      // Track the *resolved* path (separator-normalized by navigateInternal),
      // not the raw request, so the same folder reached two ways dedupes.
      const resolved = coreState.currentPath;
      recentFilesStore.add(resolved, basename(resolved), "directory");
      if (skipped > 0) {
        // Let the user know the view jumped past one or more single-child folders.
        const levels = skipped === 1 ? "subfolder" : `${skipped} subfolders`;
        toastStore.show(`Entered ${basename(resolved)} (skipped ${levels})`, "info");
      }
    }
  }

  /** Visible-entry filter matching `displayEntries` (hidden + manually-hidden
   *  rules) for a peeked listing that isn't the current pane state. Used by the
   *  auto-enter descent so its "single visible subfolder" test mirrors exactly
   *  what the user would see. */
  function visibleEntriesFor(entries: readonly FileEntry[], path: string): FileEntry[] {
    let filtered = filterHidden(entries, settingsStore.showHidden);
    const manualHiddenNames = manualHiddenStore.namesIn(path);
    if (manualHiddenNames.size > 0 && !settingsStore.showManuallyHidden) {
      filtered = filtered.filter((e) => !manualHiddenNames.has(e.name));
    }
    return filtered;
  }

  /** Walk down chains of single-child folders WITHOUT committing to pane state,
   *  returning the final folder to navigate to and how many levels were skipped.
   *  Each level is fetched read-only via fetchDirectory, so nothing renders
   *  until the caller navigates to the resolved target. Bounded to guard against
   *  pathological/symlink loops. */
  async function resolveAutoEnterTarget(
    startPath: string
  ): Promise<{ path: string; skipped: number }> {
    let current = startPath;
    let skipped = 0;
    let guard = 0;
    while (guard++ < 64) {
      const result = await fetchDirectory(current);
      if (!result.ok) break;
      const visible = visibleEntriesFor(result.data.entries, current);
      if (visible.length !== 1 || visible[0].kind !== "directory") break;
      current = visible[0].path;
      skipped++;
    }
    return { path: current, skipped };
  }

  /** Initial load for restored/seeded panes: like navigateTo but does NOT
   *  record the visit in recent files or frecency (the user didn't navigate). */
  async function initialLoad(path: string) {
    await applyNavigation(path);
  }

  async function goBack() {
    const prevPath = navigation.getBackPath(coreState.history, coreState.historyIndex);
    if (!prevPath) return;
    const status = await navigateInternal(prevPath);
    if (status === "ok") {
      coreState.historyIndex--;
    } else if (status === "error") {
      // Path no longer exists — fall back to parent
      await navigateToParent();
    }
  }

  async function goForward() {
    const nextPath = navigation.getForwardPath(coreState.history, coreState.historyIndex);
    if (!nextPath) return;
    const status = await navigateInternal(nextPath);
    if (status === "ok") {
      coreState.historyIndex++;
    } else if (status === "error") {
      // Path no longer exists — fall back to parent
      await navigateToParent();
    }
  }

  function goUp() {
    const parentPath = navigation.getParentPath(breadcrumbs);
    if (parentPath) {
      // Don't auto-descend single subfolders when going up — that would land
      // straight back in the child we just came from. (Back/forward already
      // bypass auto-enter: they use navigateInternal, not navigateTo.)
      navigateTo(parentPath, { autoEnterSingleSubdir: false });
    }
  }

  /** Jump directly to a slot in the navigation history (back/forward history
   *  popup). No-op for the current slot or an out-of-range index. */
  async function goToHistoryIndex(index: number) {
    if (index < 0 || index >= coreState.history.length) return;
    if (index === coreState.historyIndex) return;
    const path = coreState.history[index];
    const status = await navigateInternal(path);
    if (status === "ok") {
      coreState.historyIndex = index;
    } else if (status === "error") {
      await navigateToParent();
    }
  }

  /** Fallback navigation when the current directory no longer exists. */
  async function navigateToParent(): Promise<void> {
    const parentPath = navigation.getParentPath(breadcrumbs);
    if (parentPath) await navigateInternal(parentPath);
  }

  // ===================
  // Refresh & Mutations (extracted modules sharing this pane's state)
  // ===================

  const refresh = createPaneRefresh({
    coreState,
    dirListing,
    inMutationCooldown: watch.inMutationCooldown,
    updateWatch: watch.update,
    navigateToParent,
  });

  const mutations = createPaneMutations({
    coreState,
    displayEntries: () => displayEntries,
    markLocalMutation,
    getParentPath: () => navigation.getParentPath(breadcrumbs),
    navigateTo,
    refreshSilent: () => {
      // force: this is an explicit post-mutation refresh (zip create /
      // extract), which must run even though markLocalMutation just started
      // the cooldown — without force the cooldown would swallow it and the
      // result wouldn't appear until a manual refresh.
      void refresh({ silent: true, force: true });
    },
  });

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
    const entries = selection.getSelectedEntries(displayEntries, coreState.selectedPaths);
    if (contextMenuExternalEntry && coreState.selectedPaths.has(contextMenuExternalEntry.path)) {
      const alreadyIncluded = entries.some((e) => e.path === contextMenuExternalEntry!.path);
      if (!alreadyIncluded) return [...entries, contextMenuExternalEntry];
    }
    return entries;
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

  async function startDelete(entries: FileEntry | FileEntry[]) {
    const arr = Array.isArray(entries) ? entries : [entries];
    if (arr.length === 0) return;

    if (!settingsStore.confirmDelete) {
      // Delete immediately — confirmDelete handles the undo push, entry
      // removal, navigating away from deleted dirs and frecency pruning.
      await mutations.confirmDelete(arr, false);
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

  let contextMenuExternalEntry: FileEntry | null = null;

  // Identity token marking this pane as the context menu's owner, so only
  // this pane's ContextMenu instance renders the (global) menu state.
  const contextMenuOwner: object = {};

  function openContextMenu(x: number, y: number, entry?: FileEntry) {
    if (entry && !coreState.selectedPaths.has(entry.path)) {
      coreState.selectedPaths = new Set([entry.path]);
      coreState.selectionAnchorIndex = displayEntries.findIndex((e) => e.path === entry.path);
    }
    contextMenuExternalEntry = entry && coreState.selectionAnchorIndex === -1 ? entry : null;
    contextMenuStore.open(x, y, contextMenuOwner);
  }

  // ===================
  // File Operations
  // ===================

  async function createFolder(name: string): Promise<string | null> {
    const error = await mutations.createFolder(name);
    if (!error) isCreatingFolder = false;
    return error;
  }

  /** Start inline folder creation (shows editable placeholder in file list) */
  function startInlineNewFolder(): void {
    isCreatingFolder = true;
  }

  /** Cancel inline folder creation */
  function cancelInlineNewFolder(): void {
    isCreatingFolder = false;
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
        const newPaths = new Set(entries.map((e) => e.path));
        coreState.entries = [...coreState.entries.filter((e) => !newPaths.has(e.path)), ...entries];
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

    // The OS clipboard is the single source of truth for what was most
    // recently copied. We keep an internal clipboard too (it carries cut
    // semantics and richer metadata), but it's only authoritative while it
    // still matches the OS clipboard. If the user copied something in another
    // app since, the OS clipboard differs and must win — otherwise pasting a
    // file copied in Explorer silently pastes our stale internal selection.
    const internal = clipboardStore.content;
    const osContent = await clipboardStore.readOsFiles();

    const internalPaths = internal ? internal.entries.map((e) => e.path) : null;
    const osMatchesInternal =
      internalPaths !== null &&
      osContent !== null &&
      osContent.paths.length === internalPaths.length &&
      osContent.paths.every((p) => internalPaths.includes(p));
    const useInternal = internal !== null && (osContent === null || osMatchesInternal);

    if (useInternal) {
      const { entries, operation } = internal!;
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

    // OS clipboard (files copied from external apps like Explorer/Finder)
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
    if ("error" in result) {
      toastStore.error(result.error);
      return result.error;
    }

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
    get history() {
      return coreState.history;
    },
    get historyIndex() {
      return coreState.historyIndex;
    },

    // Navigation
    navigateTo,
    initialLoad,
    goBack,
    goForward,
    goToHistoryIndex,
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
    get contextMenuOwner() {
      return contextMenuOwner;
    },
    // Removable-drive-removed state (driven by ExplorerPane watching drives)
    get driveGone() {
      return driveGone;
    },
    setDriveGone(value: boolean) {
      driveGone = value;
    },
    // Inline folder creation
    get isCreatingFolder() {
      return isCreatingFolder;
    },
    startInlineNewFolder,
    cancelInlineNewFolder,
    // File operations (pane-mutations.ts)
    createFolder,
    rename: mutations.rename,
    confirmDelete: mutations.confirmDelete,
    extractArchive: mutations.extractArchive,
    compressToZip: mutations.compressToZip,
    createSymlink: mutations.createSymlinkForEntry,
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
    destroy: () => {
      watch.destroy();
      // Tear down the streaming listener and any in-flight listing,
      // otherwise each closed tab leaks a Tauri event listener.
      void dirListing.cleanup();
    },
  };
}

/** Factory function for creating explorer instances (used for multi-pane) */
export { createExplorerState };

/** Type for the explorer instance */
export type ExplorerInstance = ReturnType<typeof createExplorerState>;
