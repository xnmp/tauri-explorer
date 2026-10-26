<!--
  DetailsView - Column-based details view with VirtualList and sortable headers.
  Issue: tauri-explorer-9djf.5

  This view virtualizes individual rows and wires interactions inside FileItem.
  Tiles uses useRowGridView; List owns its horizontal column virtualizer.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { useColumnResize } from "$lib/composables/use-column-resize.svelte";
  import { DETAIL_COLUMNS, type ColumnKey } from "$lib/domain/detail-columns";
  import { fixedMenuPosition, getZoomFactor, probeSingleScaleFixedOffset } from "$lib/domain/zoom";
  import FileItem from "./FileItem.svelte";
  import VirtualList from "./VirtualList.svelte";
  import { layoutStore } from "$lib/state/layout.svelte";
  import PeekGuides from "./PeekGuides.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";

  import type { FileEntry } from "$lib/domain/file";
  import { isTrashPath } from "$lib/domain/virtual-path";

  interface Props {
    explorer: ExplorerInstance;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
    scrollToIndex?: (index: number) => void;
    containsIndex?: (index: number) => boolean;
    fallbackTabStop: boolean;
    onviewportscroll?: () => void;
    onlayoutchange?: () => void;
  }

  let { explorer, onitemclick, onitemdblclick, scrollToIndex = $bindable(), containsIndex = $bindable(), fallbackTabStop, onviewportscroll, onlayoutchange }: Props = $props();

  let rowScrollToIndex = $state<((index: number) => void) | undefined>();
  const revealIndex = (index: number) => rowScrollToIndex?.(explorer.detailRows.entryToRow[index] ?? -1);
  let rowContainsIndex = $state<((index: number) => boolean) | undefined>();
  const contains = (index: number) => rowContainsIndex?.(explorer.detailRows.entryToRow[index] ?? -1) ?? false;
  scrollToIndex = revealIndex;
  containsIndex = contains;
  onDestroy(() => {
    if (scrollToIndex === revealIndex) scrollToIndex = undefined;
    if (containsIndex === contains) containsIndex = undefined;
  });

  const viewId = $props.id();
  const inTrash = $derived(isTrashPath(explorer.currentPath));

  // Column resize composable
  const columnResize = useColumnResize(undefined, () => settingsStore.columnVisibility);

  // The new-folder editor rides INSIDE the virtual list as a sentinel first
  // item (#257) — not as a band above the scroller.
  const listItems = $derived(explorer.detailRows.rows);

  // Column header context menu state
  let columnMenuPos = $state<{ x: number; y: number } | null>(null);

  function handleColumnHeaderContextMenu(event: MouseEvent) {
    event.preventDefault();
    // FileList treats any non-entry right-click as background; the column menu
    // owns header right-clicks, so the folder menu must not open over it.
    event.stopPropagation();
    columnMenuPos = { x: event.clientX, y: event.clientY };
  }

  function closeColumnMenu() {
    columnMenuPos = null;
  }

  function positionColumnMenu(node: HTMLDivElement) {
    if (!columnMenuPos) return;
    // The pointer, viewport and measured menu must share fixed-CSS space; the
    // probe selects the engine's single or double fixed-offset scaling.
    const zoom = getZoomFactor();
    const singleScale = probeSingleScaleFixedOffset(node);
    const position = fixedMenuPosition(columnMenuPos,
      { width: window.innerWidth, height: window.innerHeight },
      { width: node.offsetWidth, height: node.offsetHeight }, zoom, singleScale);
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
  }
</script>

{#snippet resizeHandle(column: ColumnKey)}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is an interactive range. -->
  <div class="column-resize-handle" class:active={columnResize.activeColumn === column}
    role="separator" tabindex="0" aria-orientation="vertical"
    aria-label={`Resize ${DETAIL_COLUMNS[column].label} column`} aria-controls={viewId}
    aria-valuemin={DETAIL_COLUMNS[column].min} aria-valuemax={DETAIL_COLUMNS[column].max}
    aria-valuenow={columnResize.columnWidths[column]} aria-valuetext={`${Math.round(columnResize.columnWidths[column])} pixels`}
    onpointerdown={event => columnResize.startResize(column, event)}
    onpointermove={columnResize.move} onpointerup={columnResize.finish}
    onpointercancel={columnResize.cancelPointer} onlostpointercapture={columnResize.cancelPointer}
    onkeydown={event => columnResize.keydown(column, event)}></div>
{/snippet}

<div id={viewId} class="details-view" class:resizing={columnResize.isResizing} style="--col-name: {columnResize.columnWidths.name}px; --col-date: {columnResize.columnWidths.date}px; --col-type: {columnResize.columnWidths.type}px; --col-size: {columnResize.columnWidths.size}px; --col-length: {columnResize.columnWidths.length}px; --col-resolution: {columnResize.columnWidths.resolution}px; --details-grid-columns: {columnResize.gridTemplateColumns}; --details-row-height: {layoutStore.detailsRowHeight}px;">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="column-headers" data-region="column-header" style="grid-template-columns: {columnResize.gridTemplateColumns};" oncontextmenu={handleColumnHeaderContextMenu}>
    <div class="column-header-wrapper">
      <button
        class="column-header name-column"
        onclick={() => explorer.setSorting("name")}
        class:active={explorer.sortBy === "name"}
      >
        <span>Name</span>
        {#if explorer.sortBy === "name"}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
            {#if explorer.sortAscending}
              <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            {:else}
              <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            {/if}
          </svg>
        {/if}
      </button>
      {@render resizeHandle("name")}
    </div>
    {#if settingsStore.columnVisibility.date}
    <div class="column-header-wrapper">
      <button
        class="column-header date-column"
        onclick={() => explorer.setSorting("modified")}
        class:active={explorer.sortBy === "modified"}
      >
        <span>{inTrash ? "Date deleted" : "Date modified"}</span>
        {#if explorer.sortBy === "modified"}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
            {#if explorer.sortAscending}
              <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            {:else}
              <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            {/if}
          </svg>
        {/if}
      </button>
      {@render resizeHandle("date")}
    </div>
    {/if}
    {#if settingsStore.columnVisibility.type}
    <div class="column-header-wrapper">
      <div class="column-header type-column">
        <span>{inTrash ? "Original location" : "Type"}</span>
      </div>
      {@render resizeHandle("type")}
    </div>
    {/if}
    {#if settingsStore.columnVisibility.size}
    <div class="column-header-wrapper">
      <button
        class="column-header size-column"
        onclick={() => explorer.setSorting("size")}
        class:active={explorer.sortBy === "size"}
      >
        <span>Size</span>
        {#if explorer.sortBy === "size"}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="sort-indicator">
            {#if explorer.sortAscending}
              <path d="M5 2V8M5 2L2 5M5 2L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            {:else}
              <path d="M5 8V2M5 8L2 5M5 8L8 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            {/if}
          </svg>
        {/if}
      </button>
      {@render resizeHandle("size")}
    </div>
    {/if}
    {#if settingsStore.columnVisibility.length}
    <div class="column-header-wrapper">
      <div class="column-header length-column">
        <span>Length</span>
      </div>
      {@render resizeHandle("length")}
    </div>
    {/if}
    {#if settingsStore.columnVisibility.resolution}
    <div class="column-header-wrapper">
      <div class="column-header resolution-column"><span>Resolution</span></div>
      {@render resizeHandle("resolution")}
    </div>
    {/if}
  </div>

  <!-- Column visibility context menu -->
  {#if columnMenuPos}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -- click-outside backdrop pattern (matches CaretPicker/NavigationHistoryMenu); Escape/Tab away is not the primary dismiss path but the menu items themselves remain keyboard-focusable -->
    <div class="column-menu-backdrop" onclick={closeColumnMenu} oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); closeColumnMenu(); }}></div>
    <div class="column-menu" use:positionColumnMenu>
      <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("date"); closeColumnMenu(); }}>
        <span class="column-menu-check">{settingsStore.columnVisibility.date ? "✓" : ""}</span>
        Date modified
      </button>
      <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("type"); closeColumnMenu(); }}>
        <span class="column-menu-check">{settingsStore.columnVisibility.type ? "✓" : ""}</span>
        Type
      </button>
      <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("size"); closeColumnMenu(); }}>
        <span class="column-menu-check">{settingsStore.columnVisibility.size ? "✓" : ""}</span>
        Size
      </button>
      <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("length"); closeColumnMenu(); }}>
        <span class="column-menu-check">{settingsStore.columnVisibility.length ? "✓" : ""}</span>
        Length
      </button>
      <button class="column-menu-item" onclick={() => { settingsStore.toggleColumn("resolution"); closeColumnMenu(); }}>
        <span class="column-menu-check">{settingsStore.columnVisibility.resolution ? "✓" : ""}</span>
        Resolution
      </button>
    </div>
  {/if}

  <VirtualList class="file-rows"
    role={explorer.peekEnabled ? "treegrid" : "grid"} aria-label="Files" aria-multiselectable={true}
    aria-rowcount={listItems.length} aria-colcount={1}
    tabindex={fallbackTabStop ? 0 : -1}
    bind:containsIndex={rowContainsIndex}
    items={listItems}
    itemHeight={layoutStore.detailsRowHeight}
    getKey={(row) => row.key}
    {onviewportscroll}
    {onlayoutchange}
    bind:scrollToIndex={rowScrollToIndex}
  >
    {#snippet children(row, index)}
      <!-- data-row-path/-kind: the row's identity for a drag's spring-loaded
           peek (#1242), whose hit test can land on this wrapper at a row's
           pixel-snapped edge; hover and drop resolve it like the row (spring-rows.ts). -->
      <div role="row" aria-rowindex={index + 1} data-row-path={row.kind === "entry" ? row.entry.path : row.kind === "peek-state" ? row.parentPath : undefined}
        data-row-kind={row.kind === "entry" ? (row.entry.kind === "directory" ? "directory" : "file") : row.kind === "peek-state" ? "state" : undefined}
        aria-level={row.kind === "entry" && explorer.peekEnabled ? row.depth + 1 : undefined}
        aria-expanded={row.kind === "entry" && explorer.peekEnabled && row.entry.kind === "directory" ? row.expanded : undefined}
        aria-selected={row.kind === "entry" && explorer.peekEnabled ? explorer.isSelected(row.entry) : undefined}>
      {#if row.kind === "create"}
        <div role="gridcell"><InlineNewFolder {explorer} variant="details" /></div>
      {:else if row.kind === "peek-state"}
        <!-- data-peek-state names the folder: inside a drag's temporary peek
             this row drops into it (#1242); elsewhere it stays a background row. -->
        <div role="gridcell" class="peek-state" data-peek-state={row.parentPath} style:padding-left={`${(explorer.peekCaretsShown ? 41 : 29) + row.depth * 22}px`}>
          <PeekGuides groups={explorer.detailRows.groups} row={index} carets={explorer.peekCaretsShown} />
          <span role="status">{row.message}</span>
        </div>
      {:else}
        <FileItem index={row.entryIndex} entry={row.entry} {explorer}
          depth={row.depth} parentPath={row.parentPath} expanded={row.expanded}
          peek={explorer.peekEnabled} carets={explorer.peekCaretsShown} canPeek={explorer.peekEnabled && row.entry.kind === "directory"}
          groups={explorer.detailRows.groups} rowIndex={index}
          onclick={(event) => onitemclick(row.entry, event)}
          ondblclick={() => onitemdblclick(row.entry)} selected={explorer.isSelected(row.entry)} />
      {/if}
      </div>
    {/snippet}
  </VirtualList>
</div>

<style>
  .peek-state { position: relative; height: var(--details-row-height, 32px); display: flex; align-items: center; color: var(--text-tertiary); font-size: 13px; box-sizing: border-box; }
  .details-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    /* min-height:0 lets this flex child shrink below its content height so the
       inner VirtualList `.virtual-viewport` (overflow-y:auto) becomes the bounded
       vertical scroller. Without it the flex default (min-height:auto) makes this
       grow to full content height, `.content` scrolls instead, and VirtualList's
       clientHeight binding reads the full list height — so it renders EVERY row
       (virtualization defeated → scroll jank on large dirs, #469). ListView and
       TilesView already set this on their wrappers; Details was missing it. */
    min-height: 0;
    min-width: fit-content;
  }

  .column-headers {
    display: grid;
    gap: 0;
    padding: 6px 16px;
    background: var(--layout-chrome-surface, var(--background-solid));
    border-bottom: 1px solid var(--layout-hairline, var(--divider));
    position: sticky;
    top: 0;
    z-index: 5;
  }

  .column-header-wrapper {
    display: flex;
    align-items: center;
    position: relative;
  }

  .column-resize-handle {
    position: absolute;
    right: -4px;
    top: 0;
    width: 8px;
    height: 100%;
    cursor: col-resize;
    touch-action: none;
    z-index: 10;
  }

  .column-resize-handle:hover,
  .column-resize-handle.active {
    background: var(--accent);
    opacity: 0.3;
  }

  .column-resize-handle:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .details-view.resizing {
    cursor: col-resize;
    user-select: none;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-radius: 3px;
    font-family: inherit;
    font-size: var(--font-size-caption);
    font-weight: var(--font-weight-semibold);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
    cursor: pointer;
    text-align: left;
    flex: 1;
    min-width: 0;
  }

  .column-header:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .column-header.active {
    color: var(--text-primary);
  }

  .column-header:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .sort-indicator {
    opacity: 0.7;
  }

  /* Column visibility context menu */
  .column-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .column-menu {
    position: fixed;
    z-index: 100;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout);
    padding: 4px;
    min-width: 160px;
  }

  .column-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--font-size-body);
    cursor: pointer;
    text-align: left;
  }

  .column-menu-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .column-menu-check {
    width: 16px;
    text-align: center;
    color: var(--accent-text, var(--accent));
    font-size: 12px;
  }

  /* While renaming, the AI autocomplete hint (#215) floats below the
     fixed-height virtual row — let just that row overflow. !important because
     VirtualList sets overflow via an inline style. */
  .details-view :global(.virtual-item:has(.rename-input)) {
    overflow: visible !important;
    z-index: 2;
  }
</style>
