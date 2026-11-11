<!--
  MillerColumns - Ancestor directory columns panel (Finder-style).
  Issue: feat/miller-view

  Sits to the LEFT of the main file list in any view mode.
  Shows 1-3 ancestor directory listings. Clicking a directory
  navigates into it. Controlled by the pane's explorer.millerLayers
  (0=off; per-pane since #229, defaulting from settings).
-->
<script lang="ts">
  import { dragState } from "$lib/state/drag.svelte";
  import { useInlinePanelWidth } from "$lib/composables/use-inline-panel-width.svelte";
  import type { ReserveInlineWidth } from "$lib/state/pane-viewport.svelte";
  import PanelResizeHandle from "./PanelResizeHandle.svelte";
  import { untrack, onMount } from "svelte";
  import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import FileIcon from "./FileIcon.svelte";
  import EntryName from "./EntryName.svelte";
  import { createHtml5FileDrag } from "$lib/state/html5-file-drag.svelte";
  import { dropIntoDirectory } from "$lib/composables/use-dom-directory-drop";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { useDropTarget } from "$lib/composables/use-drop-target.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { isCopyModifier, usesPointerDrag, usesHtml5Drag } from "$lib/domain/platform";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import type { MillerColumns as MillerColumnListings } from "$lib/state/miller-columns.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { isSystemHidden } from "$lib/domain/file";

  const panelId = $props.id();

  interface Props {
    paneId?: string;
    reserveInlineWidth?: ReserveInlineWidth;
    explorer: ExplorerInstance;
  }

  let { explorer, paneId, reserveInlineWidth }: Props = $props();
  function paneContent(element: HTMLElement) {
    const destroy = $effect.root(() => {
      $effect(() => {
        if (paneId) return windowTabsManager.paneDialogs.registerContent(paneId, element);
      });
    });
    return { destroy };
  }

  // Ancestor listings, their cache, watches and refresh live in the state layer
  // (#1642). It loads with the first mount; listings are asynchronous anyway,
  // so the columns (and their reserved width) still appear on the first frame.
  let listings = $state.raw<MillerColumnListings | null>(null);
  onMount(() => {
    let mounted = true;
    void import("$lib/state/miller-columns.svelte").then(({ createMillerColumns }) => {
      if (mounted) listings = createMillerColumns();
    });
    return () => {
      mounted = false;
      listings?.dispose();
    };
  });

  function filterEntries(entries: readonly FileEntry[], columnPath: string, activeChildPath: string | null): FileEntry[] {
    const hideEmpty = settingsStore.millerHideEmpty;
    return entries.filter((e) => {
      if (e.kind !== "directory") return false;
      if (!settingsStore.showHidden && (e.name.startsWith(".") || e.name.startsWith("~$") || isSystemHidden(e.name))) return false;
      if (!settingsStore.showManuallyHidden && manualHiddenStore.isHidden(columnPath, e.name)) return false;
      if (hideEmpty && e.path !== activeChildPath && listings?.isEmpty(e.path) === true) return false;
      return true;
    });
  }

  // Ancestor crumbs (everything except the current directory), nearest `layers`.
  const visible = $derived.by(() => {
    const crumbs = explorer.breadcrumbs;
    const layers = explorer.millerLayers;
    if (layers === 0 || crumbs.length <= 1) return [];
    const ancestorCrumbs = crumbs.slice(0, -1);
    return ancestorCrumbs.slice(Math.max(0, ancestorCrumbs.length - layers)).map((crumb, i, all) => ({
      path: crumb.path,
      name: crumb.name,
      activeChildPath: i < all.length - 1 ? all[i + 1].path : explorer.currentPath,
    }));
  });

  // Derive displayed columns reactively so showHidden changes take effect immediately.
  const columns = $derived(visible.map((col) => {
    const entries = listings?.entries(col.path);
    return {
      ...col,
      entries: entries ? filterEntries(entries, col.path, col.activeChildPath) : [],
      loading: entries === undefined,
    };
  }));

  $effect(() => {
    const paths = visible.map((col) => col.path);
    listings?.show(paths);
  });

  // When the hide-empty toggle is flipped on while columns are already loaded,
  // back-fill emptiness flags for whatever's currently visible.
  $effect(() => {
    if (settingsStore.millerHideEmpty && listings) untrack(() => listings!.probeEmptyFlags());
  });

  function handleClick(entry: FileEntry): void {
    explorer.navigateTo(entry.path);
  }

  function handleContextMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault();
    event.stopPropagation();
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  const fileDrag = createHtml5FileDrag(() => windowTabsManager.refreshAllPanes());
  const handleDragStart = (event: DragEvent, entry: FileEntry) => fileDrag.start(event, entry);
  const handleDragEnd = fileDrag.end;

  // Shared drop-target behavior
  const dropTarget = useDropTarget({ onRefresh: () => windowTabsManager.refreshAllPanes() });

  // Ancestor columns list directories outside the pane's own listing.
  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes(),
    isListed: path => columns.some(column => column.entries.some(entry => entry.path === path)) }) : null;

  // Background drop: dropping onto empty space in a column moves to that column's dir
  let bgDropColumn = $state<string | null>(null);
  let bgDropCopy = $state(false);

  function handleBgDragOver(event: DragEvent, columnPath: string): void {
    if (!dragState.acceptsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    const copying = isCopyModifier(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    bgDropColumn = columnPath;
    bgDropCopy = copying;
  }

  function handleBgDragLeave(event: DragEvent, columnEl: HTMLElement): void {
    const related = event.relatedTarget as Node | null;
    if (related && columnEl.contains(related)) return;
    bgDropColumn = null;
    bgDropCopy = false;
  }

  async function handleBgDrop(event: DragEvent, columnPath: string): Promise<void> {
    if (!dragState.acceptsFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    bgDropColumn = null;
    bgDropCopy = false;
    if (!event.dataTransfer) return;

    await dropIntoDirectory(event, columnPath, "miller-background", { onRefresh: () => windowTabsManager.refreshAllPanes() });
  }

  // Resizable width
  const resize = usePersistedPanelWidth("explorer-miller-width", {
    min: 120,
    max: 600,
    default: 200,
  });
  useInlinePanelWidth(untrack(() => reserveInlineWidth), () => columns.length ? resize.value : 0);
</script>

{#if columns.length > 0}
  <div id={panelId} class="miller-columns" data-region="miller" data-pane-id={paneId} use:paneContent class:resizing={resize.isResizing} style="width: {resize.value}px">
    {#each columns as column (column.path)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="miller-col"
        class:bg-drop-target={bgDropColumn === column.path}
        class:bg-copy-drop={bgDropColumn === column.path && bgDropCopy}
        data-path={column.path}
        ondragover={(e) => handleBgDragOver(e, column.path)}
        ondragleave={(e) => handleBgDragLeave(e, e.currentTarget as HTMLElement)}
        ondrop={(e) => handleBgDrop(e, column.path)}
      >
        <div class="col-header" title={column.path}>{column.name}</div>
        <div class="col-entries">
          {#if column.loading}
            <div class="col-loading">...</div>
          {:else}
            {#each column.entries as entry (entry.path)}
              <button
                class="col-entry entry-item directory"
                class:active={entry.path === column.activeChildPath}
                class:drop-target={dropTarget.isDropTarget(entry.path)}
                class:copy-drop={dropTarget.isCopyDrop(entry.path)}
                data-path={entry.path}
                data-kind={entry.kind}
                onclick={() => handleClick(entry)}
                oncontextmenu={(e) => handleContextMenu(e, entry)}
                use:fileDrag.trackSource
                draggable={usesHtml5Drag}
                ondragstart={usesHtml5Drag ? (e) => handleDragStart(e, entry) : undefined}
                ondragend={usesHtml5Drag ? handleDragEnd : undefined}
                onmousedown={usesPointerDrag ? (e) => pointerDrag!.handlePointerDown(e, entry, false) : undefined}
                ondragenter={(e) => dropTarget.handleDragEnter(e, entry)}
                ondragover={(e) => dropTarget.handleDragOver(e, entry)}
                ondragleave={(e) => dropTarget.handleDragLeave(e, entry)}
                ondrop={(e) => dropTarget.handleDrop(e, entry)}
              >
                <span class="col-icon" data-drag-icon>
                  <FileIcon {entry} size="small" />
                </span>
                <span class="col-name" data-drag-name><EntryName {entry} {explorer} variant="list" /></span>
                <svg class="col-chevron" width="7" height="7" viewBox="0 0 7 7" fill="none">
                  <path d="M2 1L5 3.5L2 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {/each}
    <PanelResizeHandle {resize} label="Resize miller columns" controls={panelId} />
  </div>
{/if}

<style>
  .miller-columns {
    display: flex;
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
    background: var(--miller-bg, var(--background-card-secondary));
  }

  .miller-columns.resizing {
    user-select: none;
  }

  .miller-col {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    border-right: 1px solid var(--divider);
    overflow: hidden;
    transition: background 150ms;
  }

  .miller-col.bg-drop-target {
    background: rgba(0, 120, 212, 0.1);
  }

  .miller-col.bg-drop-target.bg-copy-drop {
    background: rgba(16, 185, 129, 0.1);
  }

  .miller-col:last-child {
    border-right: none;
  }

  .col-header {
    padding: 6px 8px;
    font-size: var(--font-size-caption, 10px);
    font-weight: var(--font-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide, 0.04em);
    color: var(--text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 0;
  }

  .col-entries {
    flex: 1;
    overflow-y: auto;
    padding: 0 4px 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .col-loading {
    padding: 8px;
    text-align: center;
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .col-entry {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
  }

  .col-entry:hover {
    background: var(--subtle-fill-secondary);
  }

  .col-entry.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    font-weight: 500;
  }

  .col-entry.drop-target {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .col-entry.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
  }

  .col-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
  }

  .col-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .col-chevron {
    color: var(--text-tertiary);
    flex-shrink: 0;
    opacity: 0.5;
  }

  .col-entry.active .col-chevron {
    color: var(--accent-text, var(--accent));
    opacity: 1;
  }

</style>
