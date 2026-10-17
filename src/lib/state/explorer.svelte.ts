/**
 * Explorer state management using Svelte 5 runes.
 * Issue: tauri-explorer-gcl, tauri-explorer-jql, tauri-explorer-h3n, tauri-explorer-x25, tauri-explorer-bhw5, tauri-explorer-u7bg, tauri-explorer-1k9k
 *
 * This store owns per-pane core state (path/history/entries/selection/
 * sort/view) and navigation. Supporting concerns live in extracted modules:
 * - Types (types.ts)
 * - Selection logic (selection.ts)
 * - Navigation/history (navigation.ts)
 * - Filesystem observation ownership (pane-watch.ts)
 * - Refresh lifecycle (pane-refresh.ts)
 * - File mutations: create/rename/delete/symlink/archive (pane-mutations.ts)
 * - Clipboard (clipboard.svelte.ts) - shared between panes
 * - Dialogs (dialogs.svelte.ts) - global dialog state
 * - Context menu (context-menu.svelte.ts) - global context menu state
 * - Undo (undo.svelte.ts) - global undo stack
 */

import { reconcileDirectorySelection } from "$lib/domain/directory-reconciliation";
import { isFileViewId } from "$lib/domain/file-view-id";
import { createFileViewPresentation } from "./file-view-presentation.svelte";
import { fileViewRegistry } from "$lib/plugins/file-view-registry.svelte";
import { resolveFileCursor } from "$lib/domain/file-list-navigation";
import { clampNumericSetting } from "$lib/domain/settings-numbers";
import { SvelteSet } from "svelte/reactivity";
import { untrack } from "svelte";
import { toastStore } from "./toast.svelte";
import { gitStatusStore } from "./git-status.svelte";
import { operationRoots } from "$lib/domain/file-operation-selection";
import { createFolderPeekState } from "./folder-peek.svelte";
import { flatPeekEntries, flatPeekRows, peekCapability, resolvePeekCommandTarget, resolvePeekEscape } from "$lib/domain/folder-peek-flat";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { providerFor } from "$lib/plugins/fs-providers";
import { basename, toNativeSeparators, pathComparison } from "$lib/domain/path";
import { isWindows } from "$lib/domain/platform";
import { clipboardImageStatus, clipboardPasteImage } from "$lib/api/clipboard-image";
import { withClipboardImageProgress } from "$lib/state/clipboard-image-progress.svelte";
import { fetchDirectory } from "$lib/api/files";
import { sortEntries, filterHidden, type FileEntry, type SortField } from "$lib/domain/file";
import type { ExplorerCoreState, SelectOptions, ViewMode } from "./types";
import * as selection from "./selection";
import * as navigation from "./navigation";
import { clipboardStore, CUT_ALREADY_PASTED } from "./clipboard.svelte";
import { dialogStore } from "./dialogs.svelte";
import { TRASH_PATH } from "$lib/domain/virtual-path";
import { frecencyStore } from "./frecency.svelte";
import { recentFilesStore } from "./recent-files.svelte";
import { contextMenuStore } from "./context-menu.svelte";
import { undoStore } from "./undo.svelte";
import { settingsStore } from "./settings.svelte";
import { manualHiddenStore } from "./manual-hidden.svelte";
import { getSortPref, saveSortPref } from "./sort-prefs";
import { pasteEntries, type PasteResult } from "./paste-operations";
import { selectPasteSource } from "$lib/domain/paste-source";
import { createDirectoryListing } from "./directory-listing";
import { createPaneWatch } from "./pane-watch";
import { createPaneRefresh } from "./pane-refresh";
import { createPaneMutations } from "./pane-mutations";
import { undoActionLabel } from "./undo-helpers";
import { broadcastFileChange } from "./file-events";
import { loadWatchdog, type LoadTraceHandle } from "./load-watchdog";
import type { LoadReason } from "$lib/domain/load-diagnostics";

import type { ExplorerSeed } from "$lib/domain/window-input";
import type { PreviewTarget } from "$lib/plugins/preview-registry.svelte";

interface NavigationFocusRequest { complete(): void; cancel(): void }
interface NavigationFocusIntent { request: NavigationFocusRequest | null; offered: boolean }

// Distinguishes concurrent panes in slow-load diagnostics (#1022).
let explorerSerial = 0;

function createExplorerState(seed?: ExplorerSeed, isFileListingSurface: () => boolean = () => true) {
  const pane = ++explorerSerial;
  // Listings are immutable revisions. Deep proxies would create per-entry
  // signals during whole-directory filtering, sorting and status aggregation.
  let entries = $state.raw<readonly FileEntry[]>(seed?.entries ?? []);
  // Explicit reveal temporarily includes a hidden entry, without changing
  // global visibility preferences. Ordinary selection/navigation retires it.
  let revealedPath = $state<string | null>(null);

  // Core per-pane state using $state rune
  let coreState = $state<ExplorerCoreState>({
    // Navigation
    currentPath: seed?.currentPath ?? "",
    history: [],
    historyIndex: -1,

    // Entries
    get entries() { return entries; },
    set entries(next: readonly FileEntry[]) { entries = next; },
    loading: !seed, // not loading if seeded
    error: null,

    // View options
    sortBy: seed?.sortBy ?? "name",
    sortAscending: seed?.sortAscending ?? true,
    viewMode: seed?.viewMode ?? settingsStore.viewMode,

    // Selection. A SvelteSet, always mutated in place via setSelection() —
    // .has(path) then subscribes per-key, so a selection change re-renders
    // only the rows whose membership actually changed, not every visible row.
    selectedPaths: new SvelteSet<string>(),
    selectionAnchorPath: null,
    cursorPath: null,
  });

  // Plugin file view preference (SDK 2). The built-in viewMode is kept while
  // a plugin view is chosen, so leaving the plugin view restores it.
  // The pane's explicit view choice: a plugin view id, null for the built-in
  // view, or undefined while it follows the default view setting.
  let fileViewChoice = $state<string | null | undefined>(undefined);
  const fileView = $derived(fileViewChoice !== undefined ? fileViewChoice
    : isFileViewId(settingsStore.defaultFileView) ? settingsStore.defaultFileView : null);

  // Presentation follows navigation intent before IO publishes currentPath.
  // Its independent lifetime survives tab remounts and ends on Explorer destroy.
  let presentationDirectory = $state(seed?.currentPath ?? "");
  const fileViewPresentation = createFileViewPresentation(() => presentationDirectory, () => fileView);

  // A plugin's non-file Preview subject. It belongs to the folder it was set
  // in and yields to any later file selection.
  let previewTarget = $state.raw<{ owner: string; target: PreviewTarget; directory: string } | null>(null);

  /** Replace the selection contents, mutating the reactive Set in place.
   *  Only added/removed keys fire; untouched rows never re-render. */
  let selectionRevision = 0;
  function setSelection(next: Iterable<string>): void {
    selectionRevision++;
    const cur = coreState.selectedPaths;
    const nextSet = next instanceof Set ? (next as ReadonlySet<string>) : new Set(next);
    if (revealedPath && !nextSet.has(revealedPath)) revealedPath = null;
    let changed = false;
    for (const path of [...cur]) {
      if (!nextSet.has(path)) { cur.delete(path); changed = true; }
    }
    for (const path of nextSet) {
      if (!cur.has(path)) { cur.add(path); changed = true; }
    }
    if (changed && nextSet.size > 0 && previewTarget) previewTarget = null;
  }

  // Inline new-entry creation state (folder or file share the same inline row)
  let creationSession = $state.raw<{ kind: "folder" | "file" } | null>(null);

  // True when the current path lives on a removable drive that has been
  // ejected/unplugged. Set by ExplorerPane, which watches the drives store.
  let driveGone = $state(false);

  // Filter query for filtering displayed entries (Ctrl+F)
  let filterQuery = $state("");
  let showFilter = $state(false);

  // Per-pane miller columns layer count (#229). null = follow the global
  // setting, so panes without an explicit choice track Settings changes.
  let millerLayersOverride = $state<number | null>(null);

  // Focus belongs to navigation intent, including a load that began before
  // its pane mounted. Completion must not claim a newer toolbar interaction.
  let navigationFocusFactory: (() => NavigationFocusRequest | null) | null = null;
  let pendingNavigationFocus: NavigationFocusIntent | null = null;
  let onRevealCallback: (() => void) | null = null;

  // Filesystem observation ownership
  const peek = createFolderPeekState(isWindows);
  const paths = pathComparison(isWindows);
  const watch = createPaneWatch({ refresh: (options) => refresh(options), currentPath: () => coreState.currentPath, refreshPath: (path, options) => refresh(options, path) });

  // Read-only state accessor for components that need the raw state bag.
  // Exposes the $state proxy itself (typed read-only) — a spread copy here
  // would rebuild the object on ANY property change and re-run every
  // consumer, destroying the proxy's per-property reactivity.
  const state: Readonly<ExplorerCoreState> = coreState;

  // ===================
  // Derived State
  // ===================

  const ownDisplayEntries = $derived.by(() => {
    let filtered = visibleEntriesFor(coreState.entries, coreState.currentPath);
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      filtered = filtered.filter((e) => e.name.toLowerCase().includes(q));
    }
    if (revealedPath && !filtered.some((entry) => entry.path === revealedPath)) {
      const revealed = coreState.entries.find((entry) => entry.path === revealedPath);
      if (revealed) filtered = [...filtered, revealed];
    }
    // Only Details view exposes sortable column headers. List and Tiles have no
    // sort UI, so they always sort by name ascending for a predictable order
    // regardless of the per-folder sort preference set in Details view.
    if (coreState.viewMode === "details") {
      return sortEntries(filtered, coreState.sortBy, coreState.sortAscending);
    }
    return sortEntries(filtered, "name", true);
  });

  const capability = $derived(isFileListingSurface() && fileViewPresentation.resolution.kind === "builtin"
    && !isVirtualPath(coreState.currentPath) && !providerFor(coreState.currentPath) ? peekCapability(coreState.viewMode) : "none");
  const peekTree = $derived(peek.policies?.flattenPeekEntries({
    root: coreState.currentPath, entries: ownDisplayEntries, expanded: peek.expanded,
    listing: path => peek.listing(path)?.entries,
    project: (entries, parent) => sortEntries(visibleEntriesFor(entries, parent), coreState.sortBy, coreState.sortAscending),
    capability: peek.expanded.size ? capability : "none", windows: isWindows,
  }) ?? flatPeekEntries(coreState.currentPath, ownDisplayEntries));
  const displayEntries = $derived(peekTree.entries as FileEntry[]);
  const detailRows = $derived(peek.policies?.buildPeekRows(peekTree, peek.listing, creationSession !== null) ?? flatPeekRows(peekTree, creationSession !== null));

  function pruneHiddenChildren(before: typeof peekTree, after: readonly FileEntry[]) {
    const visible = new Set(after.map(e => e.path));
    const hidden = new Set(before.entries.filter(e => (before.meta.get(e.path)?.depth ?? 0) > 0 && !visible.has(e.path)).map(e => e.path));
    if (!hidden.size) return;
    setSelection([...coreState.selectedPaths].filter(path => !hidden.has(path)));
    const cursorHidden = coreState.cursorPath && hidden.has(coreState.cursorPath);
    const anchorHidden = coreState.selectionAnchorPath && hidden.has(coreState.selectionAnchorPath);
    if (cursorHidden || anchorHidden) {
      let path = cursorHidden ? coreState.cursorPath : coreState.selectionAnchorPath;
      while (path && !visible.has(path)) path = before.meta.get(path)?.parentPath ?? null;
      coreState.cursorPath = path; coreState.selectionAnchorPath = null;
    }
  }
  let peekIntent = 0;
  async function togglePeek(path: string) {
    if (!peek.policies) {
      const generation = navGeneration;
      const intent = peekIntent;
      await peek.activate();
      if (destroyed || generation !== navGeneration || intent !== peekIntent) return;
    }
    const entry = displayEntries.find(e => e.path === path);
    if (capability === "none" || entry?.kind !== "directory" || isVirtualPath(path) || providerFor(path)) return;
    if (peek.watchFactory) watch.enablePeeks(peek.watchFactory);
    const before = peekTree;
    peek.toggle(path);
    pruneHiddenChildren(before, displayEntries);
    reconcilePeekResources();
  }
  function collapseAllPeeks() {
    peekIntent++;
    const before = peekTree;
    peek.collapseAll(coreState.currentPath);
    pruneHiddenChildren(before, displayEntries);
    reconcilePeekResources();
  }
  function reconcilePeekResources() {
    const reachable = coreState.loading ? [] : peekTree.expanded;
    peek.reconcile(reachable);
    return watch.reconcilePeeks(reachable, peek.expanded);
  }
  const disposePeekEffects = $effect.root(() => {
    let previous: { root: string; tree: typeof peekTree } | undefined;
    $effect(() => {
      const tree = peekTree;
      const root = coreState.currentPath;
      const reachable = coreState.loading ? [] : peekTree.expanded;
      const expanded = peek.expanded;
      untrack(() => {
        if (previous?.root === root) pruneHiddenChildren(previous.tree, tree.entries);
        previous = { root, tree };
        peek.reconcile(reachable); watch.reconcilePeeks(reachable, expanded);
      });
    });
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
  let destroyed = false;

  function captureSelection() {
    const selected = [...coreState.selectedPaths];
    const cursor = coreState.cursorPath;
    const anchor = coreState.selectionAnchorPath;
    return () => cursor === coreState.cursorPath && anchor === coreState.selectionAnchorPath &&
      selected.length === coreState.selectedPaths.size && selected.every((path) => coreState.selectedPaths.has(path));
  }

  // Accepted filesystem work outlives its pane. Only publication into that
  // pane borrows the navigation generation and lifetime.
  function captureMutation() {
    const generation = navGeneration;
    const path = coreState.currentPath;
    return {
      path,
      selectionCurrent: captureSelection(),
      current: () => !destroyed && generation === navGeneration && path === coreState.currentPath,
    };
  }

  // The pane's newest navigation trace. Starting another settles it as
  // superseded at once: a navigation queued behind a listing that never
  // returns would otherwise never reach its own settlement.
  let activeLoad: LoadTraceHandle | null = null;

  /** Start a slow-load trace (#1022) for a navigation to `path`. */
  function traceLoad(path: string, reason: LoadReason): LoadTraceHandle {
    const isSeeded = coreState.currentPath === path && coreState.entries.length > 0;
    activeLoad?.finish("superseded");
    activeLoad = loadWatchdog.begin({ path, pane, reason, spinnerVisible: !isSeeded });
    return activeLoad;
  }

  function beginNavigationFocus(): NavigationFocusIntent {
    pendingNavigationFocus?.request?.cancel();
    const intent = { request: untrack(() => navigationFocusFactory?.() ?? null), offered: navigationFocusFactory !== null };
    pendingNavigationFocus = intent;
    return intent;
  }

  function retireNavigationFocus(intent: NavigationFocusIntent) {
    intent.request?.cancel();
    intent.request = null;
    if (pendingNavigationFocus === intent) pendingNavigationFocus = null;
  }

  async function navigateInternal(
    rawPath: string,
    reason: LoadReason = "history",
    trace?: LoadTraceHandle,
    focusIntent?: NavigationFocusIntent,
  ): Promise<"ok" | "error" | "stale"> {
    // Normalize separators to the platform-native style up front. The backend
    // echoes the requested path back verbatim as `currentPath`, so this is the
    // single chokepoint that keeps the address bar (and everything that records
    // `currentPath`) consistent — never mixed `C:\Users\x/Pictures`. Gated to
    // `/` on non-Windows, where a backslash is a legal filename character.
    const path = toNativeSeparators(rawPath, isWindows ? "\\" : "/");
    if (destroyed) {
      trace?.finish("destroyed");
      if (focusIntent) retireNavigationFocus(focusIntent);
      return "stale";
    }
    presentationDirectory = path;
    creationSession = null;
    const gen = ++navGeneration;
    const navigationFocus = focusIntent ?? beginNavigationFocus();
    peek.reconcile([]);
    watch.invalidatePeeks();
    // A caller's trace is used only while it is still the pane's newest;
    // anything else starts this navigation's own trace.
    const load = trace && trace === activeLoad ? trace : traceLoad(path, reason);
    const observation = watch.begin(path);
    try {
      // If we already have entries for this path (e.g. seeded from another tab),
      // don't show loading state — the existing entries stay visible while we refresh.
      const isSeeded = coreState.currentPath === path && coreState.entries.length > 0;
      const initialSelectionRevision = selectionRevision;
      const initialCursor = coreState.cursorPath;
      if (!isSeeded) {
        coreState.loading = true;
      }
      coreState.error = null;
      filterQuery = "";
      revealedPath = null;
      showFilter = false;

      const result = await dirListing.load(path, observation, load);

      // A newer navigation started while this one was in flight — discard.
      if (gen !== navGeneration || (!result.ok && result.cancelled)) {
        load.finish(destroyed ? "destroyed" : "superseded");
        return "stale";
      }

      if (result.ok) {
        load.phase("publish");
        load.entries(result.entries.length);
        presentationDirectory = result.path;
        coreState.currentPath = result.path;
        coreState.entries = result.entries;
        peek.prune(result.path, result.entries);
        observation.commit();

        const savedSort = getSortPref(result.path);
        if (savedSort) {
          coreState.sortBy = savedSort.sortBy;
          coreState.sortAscending = savedSort.sortAscending;
        }

        // Seeded rows accept interaction before the load settles. Preserve that
        // newer selection; ordinary navigation still selects the first item.
        if (isSeeded && (selectionRevision !== initialSelectionRevision || coreState.cursorPath !== initialCursor)) {
          const membership = peek.expanded.size ? [...result.entries, ...displayEntries] : result.entries;
          const selection = reconcileDirectorySelection(membership, {
            selectedPaths: coreState.selectedPaths, cursorPath: coreState.cursorPath, anchorPath: coreState.selectionAnchorPath,
          });
          setSelection(selection.selectedPaths);
          coreState.cursorPath = selection.cursorPath;
          coreState.selectionAnchorPath = selection.anchorPath;
        } else if (displayEntries.length > 0) {
          setSelection([displayEntries[0].path]);
          coreState.selectionAnchorPath = displayEntries[0]?.path ?? null;
          coreState.cursorPath = coreState.selectionAnchorPath;
        } else {
          setSelection([]);
          coreState.selectionAnchorPath = null;
        }

        const focus = navigationFocus.request;
        navigationFocus.request = null;
        focus?.complete();

        coreState.loading = false;
        load.finish("ok");
        return "ok";
      } else {
        presentationDirectory = coreState.currentPath;
        coreState.error = result.error;
        coreState.loading = false;
        load.finish("error");
        return "error";
      }
    } finally {
      retireNavigationFocus(navigationFocus);
      observation.close();
      // Idempotent: settles a trace an unexpected throw left open.
      load.finish("error");
    }
  }

  /** Navigate and push to history. Returns true on success. */
  async function applyNavigation(path: string, reason: LoadReason, trace?: LoadTraceHandle, focusIntent?: NavigationFocusIntent): Promise<boolean> {
    const status = await navigateInternal(path, reason, trace, focusIntent);
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
   * Navigate to a directory. Returns false on failed or superseded navigation.
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
    const focusIntent = beginNavigationFocus();

    // Resolve the "auto-enter single subfolder" descent BEFORE committing any
    // navigation. Peeking at the directory listings without touching pane state
    // means the intermediate single-child folders never render — the view jumps
    // straight to the final destination in one step (no flashing). The single
    // applyNavigation below pushes exactly one history entry, so Back still
    // undoes the whole jump in one press.
    let target = path;
    let skipped = 0;
    let trace: LoadTraceHandle | undefined;
    let success: boolean;
    try {
      if (autoEnterSingleSubdir && settingsStore.autoEnterSingleSubdir) {
        // The descent is part of what the user waits for, so it is traced too.
        trace = traceLoad(path, "navigate");
        trace.phase("auto-enter");
        const descent = await resolveAutoEnterTarget(path);
        target = descent.path;
        skipped = descent.skipped;
        // The listing that follows is of the descended folder.
        trace.retarget(target);
      }
      // A navigation that started during the descent supersedes this one:
      // its result must not land after the newer folder.
      success = trace && (trace !== activeLoad || destroyed)
        ? false
        : await applyNavigation(target, "navigate", trace, focusIntent);
    } finally {
      // Idempotent: settles the trace if the descent threw.
      trace?.finish("error");
      retireNavigationFocus(focusIntent);
    }
    if (success) {
      // Track the *resolved* path (separator-normalized by navigateInternal),
      // not the raw request, so the same folder reached two ways dedupes.
      const resolved = coreState.currentPath;
      if (resolved === TRASH_PATH) frecencyStore.recordAccess(resolved);
      recentFilesStore.add(resolved, resolved === TRASH_PATH ? "Recycle Bin" : basename(resolved), "directory");
      if (skipped > 0) {
        // Let the user know the view jumped past one or more single-child folders.
        const levels = skipped === 1 ? "subfolder" : `${skipped} subfolders`;
        toastStore.show(`Entered ${basename(resolved)} (skipped ${levels})`, "info");
      }
    }
    return success;
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
    await applyNavigation(path, "initial");
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
    if (parentPath) await navigateInternal(parentPath, "parent-fallback");
  }

  // ===================
  // Refresh & Mutations (extracted modules sharing this pane's state)
  // ===================

  const refresh = createPaneRefresh({
    coreState,
    dirListing,
    allowRefresh: watch.allowRefresh,
    setSelection,
    requestReconcile: (path) => watch.changed({ path }),
    navigateToParent,
    targetFor: peek.target,
    ownsPath: (path, directory) => paths.sameParent(path, directory),
    published: (path, entries, needsRefresh) => {
      if (!needsRefresh) peek.prune(path, entries);
      if (peek.target(path)) void gitStatusStore.refreshDirectory(path);
    },
    fanOut: watch.refreshPeeks,
  });

  function captureDirectory(parent: string) {
    const root = paths.same(parent, coreState.currentPath);
    const origin = captureMutation();
    const target = root ? undefined : peek.target(parent);
    return {
      publish(transform: (entries: readonly FileEntry[]) => readonly FileEntry[]) {
        if (!origin.current() || (!root && !target?.current())) { watch.requestPath(parent); return; }
        const next = transform(root ? coreState.entries : target!.entries);
        if (root) coreState.entries = next;
        else target!.entries = next;
        peek.prune(parent, next);
      },
    };
  }

  const mutations = createPaneMutations({
    coreState,
    setSelection,
    capture: captureMutation,
    alive: () => !destroyed,
    navigateTo,
    refreshSilent: () => { void refresh({ silent: true }); },
    captureDirectory,
    operationEntries: () => displayEntries,
    requestReconcile: watch.requestPath,
    removed: (path) => {
      peek.collapseAll(path);
      setSelection([...coreState.selectedPaths].filter(p => !paths.contains(p, path)));
      reconcilePeekResources();
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

  // Per-pane only — the global default (settingsStore.viewMode, used to seed
  // new panes) changes solely via the explicit "Set Current View Mode as
  // Default" command, never as a side effect of switching one pane's view.
  function setViewMode(mode: ViewMode) {
    if (mode !== coreState.viewMode) peekIntent++;
    const before = peekTree;
    coreState.viewMode = mode;
    pruneHiddenChildren(before, displayEntries);
    reconcilePeekResources();
  }

  // ===================
  // Selection Actions
  // ===================

  function selectEntry(entry: FileEntry, options: SelectOptions = {}) {
    const result = selection.calculateSelection(
      displayEntries,
      entry,
      coreState.selectedPaths,
      coreState.selectionAnchorPath,
      options
    );
    setSelection(result.selectedPaths);
    coreState.selectionAnchorPath = result.anchorPath;
    coreState.cursorPath = entry.path;
  }

  const focusedEntry = $derived(resolveFileCursor(displayEntries, coreState.cursorPath, coreState.selectedPaths));

  function clearSelection() {
    setSelection([]);
    coreState.selectionAnchorPath = null;
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

  // A marquee drag replaces the selection on every frame. Consumers that do
  // real work per selection (the preview pane loads the file) read the settled
  // selection instead: the one the gesture started from, until it ends (#1169).
  let gestureSelection = $state.raw<FileEntry[] | null>(null);

  function beginSelectionGesture(): void {
    gestureSelection = untrack(getSelectedEntries);
  }

  function endSelectionGesture(): void {
    gestureSelection = null;
  }

  function getSettledSelectedEntries(): FileEntry[] {
    return gestureSelection ?? getSelectedEntries();
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
    setSelection(nextSet);
  }

  /** Replace listed paths, optionally retaining the marquee's anchor/cursor semantics. */
  function selectPaths(paths: readonly string[], focus: string | null = null, options: { keepAnchor?: boolean } = {}) {
    const result = selection.selectPaths(displayEntries, paths, coreState.selectionAnchorPath, coreState.cursorPath, focus, options);
    setSelection(result.selectedPaths);
    coreState.selectionAnchorPath = result.anchorPath;
    coreState.cursorPath = result.cursorPath;
  }

  function selectAll() {
    setSelection(ownDisplayEntries.map((e) => e.path));
    coreState.selectionAnchorPath = ownDisplayEntries[0]?.path ?? null;
  }

  // ===================
  // Dialog & Context Menu Actions
  // ===================

  async function startDelete(entries: FileEntry | FileEntry[]) {
    const reduced = operationRoots(Array.isArray(entries) ? entries : [entries], isWindows, displayEntries);
    if (!reduced.ok) { toastStore.error(reduced.error); return; }
    const arr = reduced.entries;
    if (arr.length === 0) return;

    if (arr.some((entry) => entry.trash)) {
      dialogStore.startDelete(arr, true);
      return;
    }

    if (!settingsStore.confirmDelete) {
      const error = await mutations.confirmDelete(arr, false);
      if (error) toastStore.error(`Delete failed: ${error}`);
      return;
    }

    dialogStore.startDelete(arr);
  }

  /** Start permanent delete — always shows confirmation dialog. */
  function startPermanentDelete(entries: FileEntry | FileEntry[]) {
    const reduced = operationRoots(Array.isArray(entries) ? entries : [entries], isWindows, displayEntries);
    if (!reduced.ok) { toastStore.error(reduced.error); return; }
    const arr = reduced.entries;
    if (arr.length === 0) return;
    dialogStore.startDelete(arr, true);
  }

  let contextMenuExternalEntry: FileEntry | null = null;

  // Identity token marking this pane as the context menu's owner, so only
  // this pane's ContextMenu instance renders the (global) menu state.
  const contextMenuOwner: object = {};

  function openContextMenu(x: number, y: number, entry?: FileEntry) {
    if (entry && !coreState.selectedPaths.has(entry.path)) {
      setSelection([entry.path]);
      coreState.selectionAnchorPath = entry.path;
      coreState.cursorPath = entry.path;
    }
    contextMenuExternalEntry = entry && !displayEntries.some((item) => item.path === entry.path) ? entry : null;
    contextMenuStore.open(x, y, contextMenuOwner);
  }

  // ===================
  // File Operations
  // ===================

  async function createFolder(name: string): Promise<string | null> {
    const session = creationSession;
    const error = await mutations.createFolder(name);
    if (!error && creationSession === session) creationSession = null;
    return error;
  }

  async function createFile(name: string): Promise<string | null> {
    const session = creationSession;
    const error = await mutations.createFile(name);
    if (!error && creationSession === session) creationSession = null;
    return error;
  }

  /** Start inline folder creation (shows editable placeholder in file list) */
  function startInlineNewFolder(): void {
    if (!destroyed && !showsPluginView()) creationSession = { kind: "folder" };
  }

  /** Start inline file creation (touch — shows editable placeholder in file list) */
  function startInlineNewFile(): void {
    if (!destroyed && !showsPluginView()) creationSession = { kind: "file" };
  }

  /** Inline rename/creation editors live in the built-in rows; a plugin file
   *  view (SDK 2) has none, so those flows are unavailable while it shows. */
  function showsPluginView(): boolean {
    return fileViewRegistry.resolve(fileView, coreState.currentPath) !== null;
  }

  /** Cancel inline new-entry creation */
  function cancelInlineNewFolder(): void {
    creationSession = null;
  }

  // ===================
  // Clipboard Actions (uses global clipboardStore for cross-pane support)
  // ===================

  async function copyToClipboard(entries: FileEntry[]) {
    const result = operationRoots(entries, isWindows, displayEntries);
    if (!result.ok) { toastStore.error(result.error); return; }
    entries = result.entries;
    if (!await clipboardStore.copy(entries)) return;
    const label = entries.length === 1 ? entries[0].name : `${entries.length} items`;
    toastStore.clipboard(`Copied: ${label}`, false);
  }

  async function cutToClipboard(entries: FileEntry[]) {
    const result = operationRoots(entries, isWindows, displayEntries);
    if (!result.ok) { toastStore.error(result.error); return; }
    entries = result.entries;
    if (!await clipboardStore.cut(entries)) return;
    const label = entries.length === 1 ? entries[0].name : `${entries.length} items`;
    toastStore.clipboard(`Cut: ${label}`, true);
  }

  // Paste result for UI feedback
  let pasteResult = $state<PasteResult | null>(null);

  function makePasteContext(origin: ReturnType<typeof captureMutation>) {
    let selectionCurrent = captureSelection();
    const pastedPaths = new Set<string>();
    return {
      destPath: origin.path,
      existingEntries: coreState.entries,
      onEntriesAdded: (entries: FileEntry[]) => {
        if (!origin.current()) return;
        const newPaths = new Set(entries.map((entry) => entry.path));
        coreState.entries = [...coreState.entries.filter((entry) => !newPaths.has(entry.path)), ...entries];
        for (const path of newPaths) pastedPaths.add(path);
        if (entries.length > 0 && selectionCurrent()) {
          setSelection(pastedPaths);
          const first = pastedPaths.values().next().value!;
          coreState.cursorPath = first;
          coreState.selectionAnchorPath = first;
          selectionCurrent = captureSelection();
        }
      },
      onRefresh: async () => {
        if (origin.current()) await refresh({ silent: true });
      },
    };
  }

  async function pasteImageAt(origin: ReturnType<typeof captureMutation>, probe: boolean): Promise<string | null | undefined> {
    return withClipboardImageProgress(origin.path, async () => {
      if (probe) {
        const status = await clipboardImageStatus();
        if (!status.ok) {
          toastStore.error(`Could not read clipboard image: ${status.error}`);
          return status.error;
        }
        if (!status.data) return undefined;
      }
      const result = await clipboardPasteImage(origin.path);
      if (!result.ok) {
        toastStore.error(`Could not paste clipboard image into ${basename(origin.path) || origin.path}: ${result.error}`);
        return result.error;
      }
      broadcastFileChange([origin.path]);
      if (origin.current()) await refresh({ silent: true });
      toastStore.success(`Clipboard image saved to ${basename(origin.path) || origin.path}`);
      return null;
    });
  }

  async function pasteImage(): Promise<string | null> {
    const origin = captureMutation();
    if (!origin.current()) return "Pane is closed";
    if (!origin.path) return "No current directory";
    return (await pasteImageAt(origin, false)) ?? null;
  }

  async function paste(): Promise<string | null> {
    const origin = captureMutation();
    if (!origin.current()) return "Pane is closed";
    if (!origin.path) return "No current directory";
    const context = makePasteContext(origin);

    // The native snapshot waits behind every accepted file clipboard job,
    // including jobs from other windows. Paste never bypasses this order.
    const { error: osReadError, snapshot } = await clipboardStore.readOsFiles();
    const source = selectPasteSource(snapshot, osReadError);

    if (source.kind === "internal") {
      const sources = source.entries.map((e) => ({ path: e.path, name: e.name, size: e.size, modified: e.modified }));
      let error: string | null;
      if (source.operation === "cut") {
        const outcome = await clipboardStore.withCutClaim(source.revision, async () => {
          let complete = false;
          const result = await pasteEntries(sources, true, context, () => { complete = true; });
          return { result, complete };
        });
        if (!outcome.claimed) {
          toastStore.show(CUT_ALREADY_PASTED, "info");
          return null;
        }
        error = outcome.result;
      } else {
        error = await pasteEntries(sources, false, context);
      }
      if (origin.current()) pasteResult = { error, timestamp: Date.now() };
      return error;
    }

    // OS clipboard (files copied from external apps like Explorer/Finder)
    if (source.kind === "external") {
      const error = await pasteEntries(
        source.paths.map((p) => ({ path: p, name: basename(p) })),
        false,
        context,
      );
      if (origin.current()) pasteResult = { error, timestamp: Date.now() };
      return error;
    }

    // Fall back to clipboard image
    const imageError = await pasteImageAt(origin, true);
    if (imageError !== undefined) return imageError;

    // Nothing pasted: only now is a clipboard read failure worth surfacing
    // (#401) — when another source (internal clipboard, image) satisfied the
    // paste, the failed file-list probe was inconsequential noise.
    const error = osReadError ? `Reading the system clipboard failed: ${osReadError}` : "Nothing in clipboard";
    toastStore.error(error);
    return error;
  }

  // ===================
  // Undo Actions
  // ===================

  async function applyHistory(direction: "undo" | "redo"): Promise<string | null> {
    const origin = captureMutation();
    if (!origin.current()) return "Pane is closed";
    const result = await undoStore[direction]();
    const warnings = result.warnings?.join("\n");
    if (result.action) {
      // Native history publishes confirmed effects even if this pane closes.
      if (!result.error) {
        const completion = `${direction === "undo" ? "Undo" : "Redo"}: ${undoActionLabel(result.action)}`;
        toastStore.show(warnings ? `${completion}\n${warnings}` : completion, "info");
      }
      if (origin.current()) await refresh({ silent: true });
    }
    if (warnings && result.error) toastStore.show(warnings, "info");
    if (result.error) toastStore.error(result.error);
    return result.error ?? null;
  }

  const undo = () => applyHistory("undo");
  const redo = () => applyHistory("redo");

  // ===================
  // Public API
  // ===================

  return {
    // Raw state bag (prefer top-level getters below)
    get state() {
      return state;
    },

    // Top-level state getters (preferred over state.*)
    fileViewPresentation,
    get ownEntries() { return coreState.entries; },
    get ownDisplayEntries() { return ownDisplayEntries; },
    get entryMeta() { return peekTree.meta; },
    get detailRows() { return detailRows; },
    get peekEnabled() { return capability !== "none"; },
    get expandedPaths() { return new Set(peek.expanded.keys()); },
    peekWatchSnapshot: watch.peekSnapshot,
    togglePeek,
    collapseAllPeeks,
    get peekCommandTarget() { return capability !== "none" ? resolvePeekCommandTarget(focusedEntry, peekTree.meta) : null; },
    get canEscapePeek() { return capability !== "none" && resolvePeekEscape(focusedEntry, peekTree.meta) !== null; },
    escapeSelectionOrPeek() {
      if (creationSession) { cancelInlineNewFolder(); return; }
      if (coreState.selectedPaths.size) { clearSelection(); return; }
      const parent = resolvePeekEscape(focusedEntry, peekTree.meta);
      if (!parent) return;
      togglePeek(parent);
      coreState.cursorPath = parent; coreState.selectionAnchorPath = null;
      onRevealCallback?.();
    },
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
    /** Plugin file view chosen for this pane (null = built-in view mode). */
    get fileView() { return fileView; },
    /** The explicit choice to persist (undefined: follows the default). */
    get fileViewChoice() { return fileViewChoice; },
    /** A malformed id is treated as the built-in view rather than stored. */
    setFileView(id: string | null) {
      const next = id !== null && isFileViewId(id) ? id : null;
      if (next !== fileView) { previewTarget = null; peekIntent++; }
      fileViewChoice = next;
    },
    /** The plugin preview target for the current folder, if any. */
    get previewTarget(): { owner: string; target: PreviewTarget } | null {
      return previewTarget && previewTarget.directory === coreState.currentPath ? previewTarget : null;
    },
    setPreviewTarget(owner: string, target: PreviewTarget | null) {
      if (!target) {
        if (previewTarget?.owner === owner) previewTarget = null;
        return;
      }
      setSelection([]);
      coreState.selectionAnchorPath = null;
      previewTarget = { owner, target, directory: coreState.currentPath };
    },
    clearPreviewTargetsOwnedBy(owner: string) {
      if (previewTarget?.owner === owner) previewTarget = null;
    },
    // Miller columns (per-pane, #229)
    get millerLayers() {
      return millerLayersOverride ?? settingsStore.millerLayers;
    },
    setMillerLayers(n: number) {
      const clamped = clampNumericSetting("millerLayers", n);
      if (clamped !== undefined) millerLayersOverride = clamped;
    },
    toggleMillerColumns() {
      const on = (millerLayersOverride ?? settingsStore.millerLayers) > 0;
      millerLayersOverride = on ? 0 : settingsStore.state.millerLayersPreferred;
    },
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
        setSelection([first.path]);
        coreState.selectionAnchorPath = first.path;
        coreState.cursorPath = first.path;
      } else {
        setSelection([]);
        coreState.selectionAnchorPath = null;
      }
    },
    clearFilter() { filterQuery = ""; },
    // Selection and independent keyboard cursor
    get focusedEntry() { return focusedEntry; },
    focusEntry(entry: FileEntry) { coreState.cursorPath = entry.path; },
    selectEntry,
    revealEntry(path: string): boolean {
      const entry = coreState.entries.find((entry) => entry.path === path);
      if (!entry) return false;
      revealedPath = path;
      filterQuery = "";
      showFilter = false;
      selectEntry(entry);
      onRevealCallback?.();
      return true;
    },
    clearSelection,
    isSelected,
    getSelectedEntries,
    getSettledSelectedEntries,
    beginSelectionGesture,
    endSelectionGesture,
    get selectionGestureActive() { return gestureSelection !== null; },
    captureMutation,
    selectByIndices,
    selectPaths,
    selectAll,
    // Dialogs
    startRename: (entry: FileEntry) => { if (!showsPluginView()) dialogStore.startRename(entry); },
    get showsPluginView() { return showsPluginView(); },
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
    // Inline new-entry creation
    get isCreatingFolder() {
      return creationSession !== null;
    },
    get newEntryKind() {
      return creationSession?.kind ?? "folder";
    },
    startInlineNewFolder,
    startInlineNewFile,
    cancelInlineNewFolder,
    // File operations (pane-mutations.ts)
    createFolder,
    createFile,
    rename: mutations.rename,
    confirmDelete: mutations.confirmDelete,
    extractArchive: mutations.extractArchive,
    compressToZip: mutations.compressToZip,
    createSymlink: mutations.createSymlinkForEntry,
    // Clipboard
    copyToClipboard,
    cutToClipboard,
    paste,
    pasteImage,
    get pasteResult() {
      return pasteResult;
    },
    // Undo/Redo
    undo,
    redo,
    // A mounted pane can attach to an initial load already in flight.
    set onNavigationFocus(factory: (() => NavigationFocusRequest | null) | null) {
      navigationFocusFactory = factory;
      if (pendingNavigationFocus) {
        pendingNavigationFocus.request?.cancel();
        pendingNavigationFocus.request = null;
        if (factory && !pendingNavigationFocus.offered) {
          pendingNavigationFocus.offered = true;
          pendingNavigationFocus.request = untrack(factory);
        }
      }
    },
    set onReveal(cb: (() => void) | null) {
      onRevealCallback = cb;
    },
    directoryChanged: watch.changed,
    // Cleanup
    destroy: async (): Promise<void> => {
      // Seal pending listings and release late observation leases,
      // so a closed tab cannot retain a late native observation lease.
      destroyed = true;
      pendingNavigationFocus?.request?.cancel();
      pendingNavigationFocus = null;
      disposePeekEffects();
      fileViewPresentation.dispose();
      creationSession = null;
      navGeneration += 1;
      activeLoad?.finish("destroyed");
      const results = await Promise.allSettled([watch.destroy(), dirListing.cleanup(), peek.dispose()]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

/** Factory function for creating explorer instances (used for multi-pane) */
export { createExplorerState };

/** Type for the explorer instance */
export type ExplorerInstance = ReturnType<typeof createExplorerState>;
