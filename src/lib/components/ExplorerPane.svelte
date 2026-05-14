<!--
  ExplorerPane component - A self-contained file explorer pane
  Each pane has its own explorer state and can be used in single or dual pane layouts.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs)
-->
<script lang="ts">
  import { setContext, tick, untrack } from "svelte";
  import { createExplorerState } from "$lib/state/explorer.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { PaneId } from "$lib/state/types";
  import NavigationBar from "./NavigationBar.svelte";
  import FileList from "./FileList.svelte";
  import MillerColumns from "./MillerColumns.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import NewFolderDialog from "./NewFolderDialog.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";
  import ScmDiffView from "./ScmDiffView.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";
  import { scmStore } from "$lib/state/scm.svelte";

  interface Props {
    paneId: PaneId;
  }

  let { paneId }: Props = $props();

  // Get explorer from window tabs manager
  const paneExplorer = $derived(windowTabsManager.getExplorer(paneId) ?? createExplorerState());

  // Provide explorer to child components via context (reactive via $derived)
  $effect(() => {
    setContext("pane-explorer", paneExplorer);
  });
  setContext("pane-id", paneId);

  let paneRef = $state<HTMLElement | null>(null);

  // Prevent default scroll on arrow keys in capture phase (WKWebView scrolls
  // before bubble-phase handlers can preventDefault).
  $effect(() => {
    const el = paneRef;
    if (!el) return;
    function captureArrows(e: KeyboardEvent) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
      }
    }
    el.addEventListener("keydown", captureArrows, true);
    return () => el.removeEventListener("keydown", captureArrows, true);
  });

  // Fetch git status when directory changes and setting is enabled.
  // untrack the fetch call to avoid $state reads inside fetchForDirectory
  // from becoming effect dependencies (would cause infinite loop).
  $effect(() => {
    const path = paneExplorer.currentPath;
    const enabled = settingsStore.showGitStatus;
    if (enabled && path) {
      untrack(() => gitStatusStore.fetchForDirectory(path));
    }
  });

  // Focus the selected item after navigation so arrow keys work immediately.
  // Uses a callback (not reactive) to avoid firing on mount or tab switch.
  function focusSelectedAfterNav() {
    const active = document.activeElement;
    if (active?.tagName === "INPUT" || active?.tagName === "TEXTAREA") return;
    tick().then(() => {
      if (!paneRef) return;
      const selected = paneRef.querySelector<HTMLElement>(".selected");
      if (selected) {
        selected.focus({ preventScroll: false });
      } else {
        paneRef.focus({ preventScroll: true });
      }
    });
  }

  $effect(() => {
    paneExplorer.onNavigate = focusSelectedAfterNav;
    return () => { paneExplorer.onNavigate = null; };
  });

  const isActive = $derived(windowTabsManager.activePaneId === paneId);
  const dualPaneEnabled = $derived(windowTabsManager.dualPaneEnabled);
  const isInactive = $derived(dualPaneEnabled && !isActive);
  const showActiveBorder = $derived(dualPaneEnabled && isActive);

  function handleFocus() {
    windowTabsManager.setActivePane(paneId);
  }

  /** Compute how many indices to jump for an arrow key in the current view.
   *  Returns 0 if the arrow key doesn't apply to this view mode.
   *
   *  Layout summary:
   *  - details: single column, up/down only
   *  - list:    grid-auto-flow: column (items fill top→bottom, then next column)
   *             up/down = ±1, left/right = ±rows_per_column
   *  - tiles:   grid row-first (items fill left→right, then next row)
   *             left/right = ±1, up/down = ±columns_per_row
   */
  function getArrowStep(key: string, viewMode: string, totalItems: number): number {
    const isVertical = key === "ArrowUp" || key === "ArrowDown";
    const isHorizontal = key === "ArrowLeft" || key === "ArrowRight";

    if (viewMode === "details") {
      return isVertical ? 1 : 0;
    }

    if (viewMode === "list") {
      if (isVertical) return 1;
      // Horizontal: jump by rows-per-column
      const gridEl = paneRef?.querySelector<HTMLElement>(".list-view");
      const cols = gridEl ? parseInt(getComputedStyle(gridEl).getPropertyValue("--list-columns")) || 1 : 1;
      return Math.ceil(totalItems / cols);
    }

    if (viewMode === "tiles") {
      if (isHorizontal) return 1;
      // Vertical: jump by columns-per-row (read from rendered grid)
      const gridEl = paneRef?.querySelector<HTMLElement>(".tiles-view");
      if (!gridEl) return 1;
      const cols = getComputedStyle(gridEl).gridTemplateColumns.split(" ").length;
      return cols;
    }

    return isVertical ? 1 : 0;
  }

  function handleKeydown(event: KeyboardEvent): void {
    // Don't process keyboard shortcuts when a dialog is open
    if (dialogStore.activeDialog) return;

    // Ignore events from interactive elements (e.g. path input, rename input)
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // Arrow key navigation in file list (not in global command system
    // because it needs current selection context and shift-key handling)
    const isArrow = event.key === "ArrowUp" || event.key === "ArrowDown"
      || event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (isArrow) {
      event.preventDefault();

      // Miller + details: ArrowLeft always goes up (even in empty folders)
      if (settingsStore.millerLayers > 0 && paneExplorer.viewMode === "details" && event.key === "ArrowLeft") {
        paneExplorer.goUp();
        return;
      }

      const entries = paneExplorer.displayEntries;
      if (entries.length === 0) return;

      const selected = paneExplorer.getSelectedEntries()[0];
      const currentIndex = selected
        ? entries.findIndex((e) => e.path === selected.path)
        : -1;

      // If nothing is selected, any arrow key selects the first item
      if (currentIndex < 0) {
        paneExplorer.selectEntry(entries[0], { ctrlKey: false, shiftKey: false });
        tick().then(() => {
          const el = paneRef?.querySelector<HTMLElement>(".selected");
          if (el && el !== document.activeElement) el.focus({ preventScroll: false });
        });
        return;
      }

      // Miller + details: ArrowRight on a folder navigates into it
      if (settingsStore.millerLayers > 0 && paneExplorer.viewMode === "details" && event.key === "ArrowRight") {
        if (selected?.kind === "directory") {
          paneExplorer.navigateTo(selected.path);
          return;
        }
      }

      const step = getArrowStep(event.key, paneExplorer.viewMode, entries.length);
      if (step === 0) return; // Arrow key not applicable in this view

      const isForward = event.key === "ArrowDown" || event.key === "ArrowRight";
      let newIndex: number;
      if (isForward) {
        newIndex = currentIndex + step;
        if (newIndex >= entries.length) return; // Already at edge
      } else {
        newIndex = currentIndex - step;
        if (newIndex < 0) return; // Already at edge
      }

      paneExplorer.selectEntry(entries[newIndex], { ctrlKey: false, shiftKey: event.shiftKey });

      // Move DOM focus to the newly selected element so focus-visible
      // tracks selection (avoids stale focus ring on the old item)
      tick().then(() => {
        const el = paneRef?.querySelector<HTMLElement>(".selected");
        if (el && el !== document.activeElement) {
          el.focus({ preventScroll: false });
        }
      });
    }
    // PageUp/PageDown: jump by PAGE_STEP items
    const PAGE_STEP = 8;
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const entries = paneExplorer.displayEntries;
      if (entries.length === 0) return;

      const selected = paneExplorer.getSelectedEntries()[0];
      const currentIndex = selected
        ? entries.findIndex((e) => e.path === selected.path)
        : -1;

      let newIndex: number;
      if (currentIndex < 0) {
        newIndex = 0;
      } else if (event.key === "PageDown") {
        newIndex = Math.min(currentIndex + PAGE_STEP, entries.length - 1);
      } else {
        newIndex = Math.max(currentIndex - PAGE_STEP, 0);
      }

      paneExplorer.selectEntry(entries[newIndex], { ctrlKey: false, shiftKey: event.shiftKey });
      tick().then(() => {
        const el = paneRef?.querySelector<HTMLElement>(".selected");
        if (el && el !== document.activeElement) {
          el.focus({ preventScroll: false });
        }
      });
    }
    // All other shortcuts (Ctrl+C/X/V/Z/A, Delete, F2, F5, F6, Enter, etc.)
    // are handled by the global keybinding system in command-definitions.ts
  }

  // Note: Tab initialization is handled at page level by windowTabsManager
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  bind:this={paneRef}
  class="explorer-pane"
  class:active={showActiveBorder}
  class:inactive={isInactive}
  role="region"
  aria-label="{paneId} file browser pane"
  tabindex="0"
  onfocus={handleFocus}
  onclick={handleFocus}
  onkeydown={handleKeydown}
>
  {#if paneExplorer}
    <NavigationBar explorer={paneExplorer} />
    <div class="pane-content">
      {#if isActive && settingsStore.showGitStatus && scmStore.activeDiff && scmStore.repoRoot}
        <ScmDiffView
          repoPath={scmStore.repoRoot}
          path={scmStore.activeDiff.path}
          staged={scmStore.activeDiff.staged}
        />
      {:else}
        {#if settingsStore.millerLayers > 0}
          <MillerColumns explorer={paneExplorer} />
        {/if}
        <FileList explorer={paneExplorer} />
      {/if}
    </div>
    <ContextMenu explorer={paneExplorer} />
    <NewFolderDialog explorer={paneExplorer} />
    <DeleteDialog explorer={paneExplorer} />
  {/if}
</section>

<style>
  .explorer-pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    background: color-mix(in srgb, var(--background-card) calc(var(--content-opacity, 1) * 100%), transparent);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast),
      opacity var(--transition-fast);
  }

  .explorer-pane:focus {
    outline: none;
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
</style>
