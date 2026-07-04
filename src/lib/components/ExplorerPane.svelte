<!--
  ExplorerPane component - A self-contained file explorer pane
  Each pane has its own explorer state and can be used in single or dual pane layouts.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs)
-->
<script lang="ts">
  import { tick, untrack } from "svelte";
  import { setPaneIdContext } from "$lib/state/pane-context";
  import { createExplorerState } from "$lib/state/explorer.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { PaneId } from "$lib/state/types";
  import NavigationBar from "./NavigationBar.svelte";
  import FileList from "./FileList.svelte";
  import MillerColumns from "./MillerColumns.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";
  import { drivesStore } from "$lib/state/drives.svelte";
  import { directoryKey } from "$lib/domain/path";
  import { isVirtualPath } from "$lib/domain/virtual-path";

  interface Props {
    paneId: PaneId;
  }

  let { paneId }: Props = $props();

  // paneId is a static literal per pane instance (see PaneContainer), so
  // capturing it at init is safe. Consumed by GitStatusBadge to resolve the
  // directory its entry is rendered in.
  setPaneIdContext(untrack(() => paneId));

  // Get explorer from window tabs manager
  const paneExplorer = $derived(windowTabsManager.getExplorer(paneId) ?? createExplorerState());

  let paneRef = $state<HTMLElement | null>(null);

  // All keyboard navigation is handled at window level so it works regardless
  // of focus state. Only the active pane responds.
  $effect(() => {
    if (!isActive) return;
    function onWindowKeydown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (dialogStore.activeDialog) return;
      handleKeydown(e);
    }
    window.addEventListener("keydown", onWindowKeydown);
    return () => window.removeEventListener("keydown", onWindowKeydown);
  });

  // Fetch git status when directory changes and setting is enabled.
  // untrack the fetch call to avoid $state reads inside fetchForDirectory
  // from becoming effect dependencies (would cause infinite loop).
  $effect(() => {
    const path = paneExplorer.currentPath;
    const enabled = settingsStore.showGitStatus;
    // Virtual (`scheme://…`) paths aren't real repos — skip git status.
    if (enabled && path && !isVirtualPath(path)) {
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

  // Track which removable drive (if any) the current path lives on, and flag
  // the pane when that drive is unplugged/ejected so it can show a clear
  // "removable drive removed" state instead of a generic listing error.
  let removableRoot = $state<string | null>(null);
  // Both the pane path and the drive roots are reduced to the same canonical
  // key (forward slashes, no trailing separator, case-folded for Windows), so a
  // single forward-slash containment check covers every separator/case variant.
  const normalizeRoot = (p: string) => directoryKey(p);
  const isUnder = (path: string, root: string) =>
    path === root || path.startsWith(root + "/");

  $effect(() => {
    const pathNorm = normalizeRoot(paneExplorer.currentPath);
    const roots = drivesStore.removableRoots; // reactive: present removable drives
    if (!pathNorm) {
      removableRoot = null;
      return;
    }
    // Longest present removable root the path sits under → remember it.
    const present = roots
      .filter((root) => isUnder(pathNorm, root))
      .sort((a, b) => b.length - a.length)[0];
    if (present) {
      removableRoot = present;
    } else if (removableRoot && !isUnder(pathNorm, removableRoot)) {
      // No longer under the remembered drive (user navigated elsewhere) — reset.
      removableRoot = null;
    }
  });

  $effect(() => {
    const root = removableRoot;
    if (!root) {
      paneExplorer.setDriveGone(false);
      return;
    }
    // The drive is "gone" once its root is absent from the mounted set.
    paneExplorer.setDriveGone(!drivesStore.mountedRoots.has(root));
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
   *  Layout summary (List and Tiles are both row-major since #128 — items fill
   *  left→right then top→down — so they navigate identically):
   *  - details: single column, up/down only
   *  - list/tiles: left/right = ±1, up/down = ±columns_per_row
   *
   *  The view exposes its live column count via a `data-columns` attribute on
   *  the `.list-view` / `.tiles-view` container (the grid itself is now split
   *  across per-row elements, so there is no single grid to measure).
   */
  function gridColumns(viewMode: string): number {
    const gridEl = paneRef?.querySelector<HTMLElement>(`.${viewMode}-view`);
    const cols = gridEl ? parseInt(gridEl.dataset.columns ?? "") : NaN;
    return Number.isFinite(cols) && cols > 0 ? cols : 1;
  }

  function getArrowStep(key: string, viewMode: string, _totalItems: number): number {
    const isVertical = key === "ArrowUp" || key === "ArrowDown";
    const isHorizontal = key === "ArrowLeft" || key === "ArrowRight";

    if (viewMode === "details") {
      return isVertical ? 1 : 0;
    }

    if (viewMode === "list" || viewMode === "tiles") {
      // Row-major: horizontal moves one item, vertical moves a whole row.
      if (isHorizontal) return 1;
      return gridColumns(viewMode);
    }

    return isVertical ? 1 : 0;
  }

  function isYaziNavView(): boolean {
    if (!settingsStore.yaziNavigation) return false;
    if (paneExplorer.viewMode === "details") return true;
    if (paneExplorer.viewMode === "list") {
      return gridColumns("list") === 1;
    }
    return false;
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

      // ArrowLeft goes up one level in details view, or list view with single column (yazi-style)
      if (event.key === "ArrowLeft" && isYaziNavView()) {
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

      // ArrowRight on a folder navigates into it (yazi-style)
      if (event.key === "ArrowRight" && isYaziNavView()) {
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
    // PageUp/PageDown: jump by PAGE_STEP items (skip if any modifier held — likely a command shortcut)
    const PAGE_STEP = 8;
    if ((event.key === "PageUp" || event.key === "PageDown") && !event.ctrlKey && !event.metaKey && !event.altKey) {
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
>
  {#if paneExplorer}
    <NavigationBar explorer={paneExplorer} />
    <div class="pane-content">
      {#if settingsStore.millerLayers > 0 && !(settingsStore.macOsVibrancy && !settingsStore.showSidebar)}
        <MillerColumns explorer={paneExplorer} />
      {/if}
      <FileList explorer={paneExplorer} />
    </div>
    <ContextMenu explorer={paneExplorer} />
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
    border-radius: 0;
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

  /* Vibrancy: flatten inside the island */
  :global([data-vibrancy]) .explorer-pane {
    background: transparent;
    border-radius: 0;
    border-color: transparent;
    box-shadow: none;
  }
</style>
