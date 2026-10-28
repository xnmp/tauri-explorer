<!--
  ExplorerPane component - A self-contained file explorer pane
  Each pane has its own explorer state and can be used in single or dual pane layouts.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs)
-->
<script lang="ts">
  import { clickSelectionEffect } from "$lib/domain/workspace-selection";
  import { createPanePointerFocus, focusFirstAccepting } from "$lib/state/pane-pointer-focus";
  import { resolveFileListMove } from "$lib/domain/file-list-navigation";
  import { tick, untrack } from "svelte";
  import { layoutStore } from "$lib/state/layout.svelte";
  import { createDeferredFocusRequest } from "$lib/state/deferred-focus";
  import { setPaneIdContext } from "$lib/state/pane-context";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { PaneId } from "$lib/state/types";
  import NavigationBar from "./NavigationBar.svelte";
  import FileList from "./FileList.svelte";
  import MillerColumns from "./MillerColumns.svelte";
  import ContextMenu from "./ContextMenu.svelte";
import ScmPanel from "./ScmPanel.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";
  import { gitWarmer } from "$lib/state/git-warm";
  import { gitGraphComponent } from "$lib/state/git-graph-component";
  import { drivesStore } from "$lib/state/drives.svelte";
  import { directoryKey } from "$lib/domain/path";
  import { gitRepoRoot } from "$lib/api/git";
import { nextRemovableRoot } from "$lib/domain/drives";
  import { isVirtualPath } from "$lib/domain/virtual-path";
  import { explainTrashedOpen } from "$lib/state/trash-provider";

  interface Props {
    paneId: PaneId;
    explorer: ExplorerInstance;
  }

  let { paneId, explorer }: Props = $props();
  // PaneLayoutView keys this component by the explorer instance. Capture the
  // resource for the entire mount, including cleanup after the parent removes
  // its registry entry (when a reactive prop lookup can already be undefined).
  const paneExplorer = untrack(() => explorer);

  // paneId is a static literal per pane instance (see PaneContainer), so
  // capturing it at init is safe. Consumed by GitStatusBadge to resolve the
  // directory its entry is rendered in.
  setPaneIdContext(untrack(() => paneId));
  const mountedPaneId = untrack(() => paneId);
  function paneContent(element: HTMLElement) {
    return { destroy: windowTabsManager.paneDialogs.registerContent(mountedPaneId, element) };
  }
  function dialogSlot(slot: HTMLElement) {
    return { destroy: windowTabsManager.paneDialogs.registerSlot(mountedPaneId, slot, () => {
      focusFirstAccepting([
        paneRef?.querySelector<HTMLElement>('.entry-item[tabindex="0"], [role="gridcell"][tabindex="0"]'),
        paneRef,
      ], () => document.activeElement);
    }) };
  }
  const reserveInlineWidth = () => windowTabsManager.paneViewport.reserveInlineWidth(mountedPaneId);

  // Repo whose commit graph this pane shows instead of the file listing
  // (#272). Toggled per-pane via git.showGraph (Ctrl+Alt+G).
  const paneGitGraph = $derived(windowTabsManager.getPaneGitGraph(paneId));

  function loadGraphComponent() {
    return gitGraphComponent.load(() => import("./GitGraphView.svelte").then((module) => module.default))
      .catch((error) => {
        console.error("Could not load Git history:", error);
        throw error;
      });
  }

  // Per-pane SCM panel visibility (#434): explicit per-pane override, else the
  // global `showScmPanel` default.
  const paneScmVisible = $derived(windowTabsManager.getPaneScmVisible(paneId));

  const fileViewPresentation = paneExplorer.fileViewPresentation;
  const pluginViewActive = $derived(fileViewPresentation.resolution.kind !== "builtin");

  let paneRef = $state<HTMLElement | null>(null);
  let getListNavigation = $state<(() => import("$lib/domain/list-column-flow").ListNavigationSnapshot | null) | undefined>();
  let getTilesNavigation = $state<(() => import("$lib/domain/tile-panel-navigation").TileNavigationSnapshot | null) | undefined>();
  let fileListScrollToEntry = $state<((entry: import("$lib/domain/file").FileEntry) => void) | undefined>();

  // All keyboard navigation is handled at window level so it works regardless
  // of focus state. Only the active pane responds.
  $effect(() => {
    if (!isActive) return;
    function onWindowKeydown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.closest?.('[role="separator"]')) return;
      if (dialogStore.isPaneBlocked(paneId) || dialogStore.isInputBlocked(e, paneId)) return;
      handleKeydown(e);
    }
    window.addEventListener("keydown", onWindowKeydown);
    return () => window.removeEventListener("keydown", onWindowKeydown);
  });

  // Keep an open commit graph pointed at the pane's directory (#362):
  // navigating while the graph shows (sidebar, miller columns, terminal
  // cwd-sync) retargets the graph at the new directory's repo, or closes
  // it back to the file listing when the directory isn't in a repo.
  $effect(() => {
    const graphRepo = paneGitGraph;
    const path = paneExplorer.currentPath;
    if (!graphRepo || !path || isVirtualPath(path)) return;
    const pathKey = directoryKey(path);
    const repoKey = directoryKey(graphRepo);
    // Still inside the graph's repo: nothing to do (no IPC).
    if (pathKey === repoKey || pathKey.startsWith(repoKey + "/")) return;
    untrack(() =>
      gitRepoRoot(path).then((result) => {
        // Stale guards: the pane may have navigated again, closed the
        // graph, or already been retargeted while the probe ran.
        if (windowTabsManager.getPaneGitGraph(paneId) !== graphRepo) return;
        if (paneExplorer.currentPath !== path) return;
        const root = result.ok ? result.data : null;
        if (root && directoryKey(root) === repoKey) return;
        windowTabsManager.setPaneGitGraph(paneId, root);
      }),
    );
  });

  // Fetch git status when directory changes and setting is enabled.
  // untrack the fetch call to avoid $state reads inside fetchForDirectory
  // from becoming effect dependencies (would cause infinite loop).
  $effect(() => {
    const path = paneExplorer.currentPath;
    const enabled = settingsStore.showGitStatus;
    // Virtual (`scheme://…`) paths aren't real repos — skip git.
    if (path && !isVirtualPath(path)) {
      const release = enabled
        ? untrack(() => {
            const release = gitStatusStore.trackDirectory(path);
            void gitStatusStore.fetchForDirectory(path);
            return release;
          })
        : null;
      // After (not blocking) the badge fetch, warm the git-graph + SCM caches
      // in the background (#287). Debounce + per-feature gating live in the
      // warmer; non-git users pay zero extra IPC.
      const releaseWarm = untrack(() => gitWarmer.schedule(path, paneId));
      return () => {
        release?.();
        releaseWarm();
      };
    }
  });

  // Capture ownership before IO; seeded panes can already accept interaction
  // while their initial listing is still settling.
  let navigationFocusRequest: ReturnType<typeof createDeferredFocusRequest> | null = null;
  function prepareNavigationFocus() {
    navigationFocusRequest?.cancel();
    navigationFocusRequest = null;
    if (windowTabsManager.getActiveExplorer() !== paneExplorer) return null;
    const active = document.activeElement;
    const request = createDeferredFocusRequest(window, () =>
      !!paneRef?.isConnected && windowTabsManager.getActiveExplorer() === paneExplorer
      && !dialogStore.isPaneBlocked(paneId)
      && !document.activeElement?.matches("input, textarea, select, [contenteditable='true']")
      && (document.activeElement === active
        || (!!active && !active.isConnected && document.activeElement === document.body)),
    );
    navigationFocusRequest = request;
    return {
      cancel: request.cancel,
      complete() {
        void tick().then(() => {
          if (navigationFocusRequest === request) navigationFocusRequest = null;
          if (!request.consume()) return;
          const selected = paneExplorer.focusedEntry;
          if (selected) fileListScrollToEntry?.(selected);
          else paneRef?.focus({ preventScroll: true });
        });
      },
    };
  }

  function revealSelectedAfterSelection() {
    const selected = paneExplorer.focusedEntry;
    if (!selected) return;
    // Trace is rebuilt when selection changes, so its clicked button can
    // unmount before this render. Ownership belongs to the pane and target.
    void tick().then(() => {
      if (paneRef?.isConnected && windowTabsManager.getActiveExplorer() === paneExplorer
        && paneExplorer.focusedEntry?.path === selected.path) fileListScrollToEntry?.(selected);
    });
  }

  $effect(() => {
    paneExplorer.onNavigationFocus = prepareNavigationFocus;
    paneExplorer.onReveal = revealSelectedAfterSelection;
    return () => {
      navigationFocusRequest?.cancel();
      navigationFocusRequest = null;
      paneExplorer.onNavigationFocus = null;
      paneExplorer.onReveal = null;
    };
  });

  // Track which removable drive (if any) the current path lives on, and flag
  // the pane when that drive is unplugged/ejected so it can show a clear
  // "removable drive removed" state instead of a generic listing error.
  // The remembering logic is a pure fold (domain/drives.ts); this single
  // effect runs the fold and pushes the outcome into the pane store.
  // `removableRoot` is deliberately a plain variable, not $state: it is only
  // read here, and reactivity would re-trigger the effect on its own write.
  let removableRoot: string | null = null;
  $effect(() => {
    removableRoot = nextRemovableRoot(
      removableRoot,
      directoryKey(paneExplorer.currentPath),
      drivesStore.removableRoots,
    );
    // The drive is "gone" once its root is absent from the mounted set.
    paneExplorer.setDriveGone(
      removableRoot !== null && !drivesStore.mountedRoots.has(removableRoot),
    );
  });

  const isActive = $derived(windowTabsManager.activePaneId === paneId);
  const dualPaneEnabled = $derived(windowTabsManager.dualPaneEnabled);

  // Miller columns are hoisted to the left island (rendered by +page.svelte)
  // only in island mode with no sidebar, and only for the active pane (the
  // island shows the active explorer). When hoisted, suppress the inline copy
  // so the columns render exactly once (#434). Mirrors `millerAsLeftIsland`.
  const millerHoistedToIsland = $derived(
    layoutStore.islands && !settingsStore.showSidebar && isActive,
  );
  const isInactive = $derived(dualPaneEnabled && !isActive);
  const showActiveBorder = $derived(dualPaneEnabled && isActive);

  function handleFocus() {
    windowTabsManager.setActivePane(paneId);
  }

  const pointerFocus = createPanePointerFocus();
  /** Rows and SDK file tiles: the surfaces whose selection is click-owned. */
  const ENTRY_SURFACE = '.entry-item, .file-tiles-grid [role="gridcell"]';

  function handleFocusIn(): void {
    // Focus the pointer moved here during an additive gesture is returned on release.
    if (!pointerFocus.active) handleFocus();
  }

  function keepsPaneFocus(event: MouseEvent): boolean {
    const target = event.target;
    // Editors and other pane chrome keep their normal focus behavior.
    return target instanceof Element && !!target.closest(ENTRY_SURFACE)
      && !target.closest("input, textarea, button, a, [contenteditable]")
      && !clickSelectionEffect(event, paneId, windowTabsManager.activePaneId).focusPane;
  }

  function handleMouseDown(event: MouseEvent): void {
    const previousFocus = document.activeElement;
    const focusedPane = windowTabsManager.activePaneId;
    pointerFocus.begin(keepsPaneFocus(event) ? () => {
      if (windowTabsManager.activePaneId !== focusedPane) return;
      const owner = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(focusedPane)}"]`);
      // The previous focus owner only counts when it lies inside the pane that
      // was active: stale focus left in another pane (e.g. after a keyboard pane
      // switch) must never be restored, or that pane would become active. It may
      // also be document.body or unfocusable, so fall back to the pane's own
      // row/tile, then the pane element, which keeps keyboard input with it.
      focusFirstAccepting([
        previousFocus instanceof HTMLElement && previousFocus.isConnected && owner?.contains(previousFocus)
          ? previousFocus : null,
        owner?.querySelector<HTMLElement>('.entry-item[tabindex="0"], [role="gridcell"][tabindex="0"]'),
        owner,
      ], () => document.activeElement);
    } : null);
  }

  function handlePaneClick(event: MouseEvent): void {
    pointerFocus.end();
    if (keepsPaneFocus(event)) return;
    handleFocus();
    // A view that owns selection (SDK tiles) may have activated this pane
    // itself; DOM focus must follow the active pane, as FileList does for rows.
    const cell = event.target instanceof Element ? event.target.closest<HTMLElement>(ENTRY_SURFACE) : null;
    if (cell && !paneRef?.contains(document.activeElement)) cell.focus({ preventScroll: true });
  }

  /** Select an entry and ask FileList's active virtualized view to reveal it. */
  function selectAndReveal(
    entry: import("$lib/domain/file").FileEntry,
    options: { ctrlKey: boolean; shiftKey: boolean },
    index?: number,
  ): void {
    paneExplorer.selectEntry(entry, options, index);
    fileListScrollToEntry?.(entry);
  }

  function gridColumns(viewMode: string): number {
    const gridEl = paneRef?.querySelector<HTMLElement>(`.${viewMode}-view`);
    const cols = gridEl ? parseInt(gridEl.dataset.columns ?? "") : NaN;
    return Number.isFinite(cols) && cols > 0 ? cols : 1;
  }

  function handleKeydown(event: KeyboardEvent): void {
    // A plugin file view owns keyboard navigation within its own content.
    if (event.defaultPrevented || dialogStore.isPaneBlocked(paneId) || dialogStore.isInputBlocked(event, paneId) || paneGitGraph || pluginViewActive) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]')) return;
    // File navigation belongs to the collection. Ordinary controls, Miller
    // columns and sidebar widgets retain their own arrow keys. A pane-switch
    // command changes active-pane state before the old collection loses focus.
    if (!target.matches('.file-list .entry-item, .file-list .virtual-viewport:is([role="grid"], [role="treegrid"], [role="tree"], [role="listbox"]), .explorer-pane, body')) return;
    const entries = paneExplorer.displayEntries;
    const cursor = paneExplorer.focusedEntry;
    const move = resolveFileListMove(event, {
      viewMode: paneExplorer.viewMode, columns: gridColumns(paneExplorer.viewMode),
      count: entries.length, cursorIndex: cursor ? paneExplorer.cursorIndex : -1,
      listLayout: settingsStore.folderPeek ? "columns" : "rows", list: getListNavigation?.(), tiles: getTilesNavigation?.(),
      directory: cursor?.kind === "directory", yazi: settingsStore.yaziNavigation,
    });
    if (!move) return;
    event.preventDefault();
    if (move.kind === "handled") return;
    if (move.kind === "parent") { void paneExplorer.goUp(); return; }
    if (move.kind === "open") {
      const target = entries[move.index];
      // A trashed folder opens only after Restore (#863).
      if (target.trash) explainTrashedOpen(target);
      else void paneExplorer.navigateTo(target.path);
      return;
    }
    const entry = entries[move.index];
    if (move.selection === "preserve") {
      paneExplorer.focusEntry(entry, move.index);
      fileListScrollToEntry?.(entry);
    } else {
      selectAndReveal(entry, { ctrlKey: false, shiftKey: move.selection === "extend" }, move.index);
    }
  }

  // Note: Tab initialization is handled at page level by windowTabsManager
</script>

<svelte:window
  onpointerdowncapture={() => pointerFocus.end()}
  onpointercancel={() => pointerFocus.end()}
  onmouseup={() => pointerFocus.release()}
  onkeydowncapture={() => pointerFocus.end()}
  onblur={() => pointerFocus.end()}
/>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- pane-level click-to-focus delegation; keyboard users get the same activation via Tab + onfocus below -->
<!-- svelte-ignore a11y_click_events_have_key_events -- onclick mirrors onfocus, so Tab already provides the keyboard equivalent -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -- tabindex=0 is required so keyboard users can Tab into the pane, mirroring the click handler -->
<section
  bind:this={paneRef}
  class="explorer-pane"
  data-region="pane"
  data-active={showActiveBorder || undefined}
  class:active={showActiveBorder}
  class:inactive={isInactive}
  aria-label="file browser pane"
  tabindex="0"
  data-pane-id={paneId}
  onfocusincapture={handleFocusIn}
  onmousedowncapture={handleMouseDown}
  ondragstartcapture={() => { pointerFocus.end(); handleFocus(); }}
  onclick={handlePaneClick}
>
  <div class="pane-base-content" use:paneContent>
  {#if paneGitGraph}
    <div class="pane-content">
      <!-- Same gating as the explorer branch below: the SCM panel stays
           available while the graph has the pane (#333). Per-pane visibility
           (#434). -->
      {#if settingsStore.showGitStatus && paneScmVisible}
        <ScmPanel {reserveInlineWidth} />
      {/if}
      <!-- Keyed so switching between graphs of different repos recreates the
           view — no selected-commit/state bleed or in-flight races (#167). -->
      {#key paneGitGraph}
        {@const CachedGraph = gitGraphComponent.current}
        {#if CachedGraph}
          <CachedGraph repoPath={paneGitGraph} />
        {:else}
          {#await loadGraphComponent()}
            <div class="graph-load-status" role="status">Loading history…</div>
          {:then Graph}
            <Graph repoPath={paneGitGraph} />
          {:catch}
            <div class="graph-load-status" role="alert">
              <p>Could not load Git history. Restart the app and try again.</p>
              <button onclick={() => windowTabsManager.setPaneGitGraph(paneId, null)}>Return to files</button>
            </div>
          {/await}
        {/if}
      {/key}
    </div>
  {:else if paneExplorer}
    <NavigationBar explorer={paneExplorer} {paneId} />
    <div class="pane-content">
      <!-- Miller columns render inline UNLESS they are hoisted to the left
           island (island mode + no sidebar, active pane only). The hoist
           condition here must mirror `millerAsLeftIsland` in +page.svelte,
           keyed off the single `layoutStore.islands` arrangement — not one platform's flag —
           or the columns double-mount inline AND as the island (#434). -->
      {#if paneExplorer.millerLayers > 0 && !millerHoistedToIsland}
        <MillerColumns explorer={paneExplorer} {paneId} {reserveInlineWidth} />
      {/if}
      <!-- SCM panel sits between the Miller columns and the file list (#227);
           per pane (#334, #434) — each pane's panel follows its own explorer
           and its own visibility toggle, so two panes show independent git
           panels and can be opened/closed independently. -->
      {#if settingsStore.showGitStatus && paneScmVisible}
        <ScmPanel {reserveInlineWidth} />
      {/if}
      <FileList explorer={paneExplorer} presentation={fileViewPresentation} bind:scrollToEntry={fileListScrollToEntry} bind:getListNavigation bind:getTilesNavigation />
    </div>
    <ContextMenu explorer={paneExplorer} />
  {/if}
  </div>
  <div class="pane-dialog-slot" use:dialogSlot></div>
  {#if paneExplorer}
    <DeleteDialog explorer={paneExplorer} />
  {/if}
</section>

<style>
  .graph-load-status {
    flex: 1;
    align-self: center;
    text-align: center;
    padding: 16px;
    color: var(--text-secondary);
    font-size: 13px;
  }

  .graph-load-status button {
    font: inherit;
    color: var(--text-primary);
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    cursor: pointer;
  }

  .graph-load-status button:hover {
    background: var(--control-fill-secondary);
  }

  .graph-load-status button:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
  }

  .explorer-pane {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    background: var(--layout-surface, color-mix(in srgb, var(--background-card) calc(var(--content-opacity, 1) * 100%), transparent));
    border-radius: 0;
    border: 1px solid transparent;
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast),
      opacity var(--transition-fast);
  }

  /* Active border only shows in dual pane mode */
  .explorer-pane.active {
    border-color: var(--accent);
    box-shadow: var(--shadow-card, 0 1px 3px rgba(0, 0, 0, 0.06)), 0 0 6px -2px var(--accent);
  }

  /* Inactive pane in dual pane mode */
  .explorer-pane.inactive {
    opacity: 0.7;
    border-color: var(--divider);
  }

  .explorer-pane.inactive:hover {
    opacity: 0.9;
    border-color: var(--text-tertiary);
  }

  .pane-content {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .pane-base-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .pane-dialog-slot {
    /* Retain the portal/focus registration without covering listing cells
       when no dialog is mounted. DOM portals update :empty synchronously. */
    display: contents;
  }

  .pane-dialog-slot:not(:empty) {
    display: block;
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: var(--z-modal, 1000);
  }

</style>
