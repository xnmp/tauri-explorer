<!--
  DetailsView - Column-based details view with VirtualList and sortable headers.
  Issue: tauri-explorer-9djf.5
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { useColumnResize } from "$lib/composables/use-column-resize.svelte";
  import FileItem from "./FileItem.svelte";
  import VirtualList from "./VirtualList.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
  }

  let { explorer, onitemclick, onitemdblclick }: Props = $props();

  // Column resize composable
  const columnResize = useColumnResize(undefined, () => settingsStore.columnVisibility);

  // Column header context menu state
  let columnMenuPos = $state<{ x: number; y: number } | null>(null);

  function handleColumnHeaderContextMenu(event: MouseEvent) {
    event.preventDefault();
    columnMenuPos = { x: event.clientX, y: event.clientY };
  }

  function closeColumnMenu() {
    columnMenuPos = null;
  }
</script>

<svelte:window
  onmousemove={(e) => columnResize.handleResize(e)}
  onmouseup={() => columnResize.endResize()}
/>

<div class="details-view" class:resizing={columnResize.isResizing} style="--col-name: {columnResize.columnWidths.name}px; --col-date: {columnResize.columnWidths.date}px; --col-type: {columnResize.columnWidths.type}px; --col-size: {columnResize.columnWidths.size}px; --details-grid-columns: {columnResize.gridTemplateColumns};">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="column-headers" style="grid-template-columns: {columnResize.gridTemplateColumns};" oncontextmenu={handleColumnHeaderContextMenu}>
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
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("name", e)}></div>
    </div>
    {#if settingsStore.columnVisibility.date}
    <div class="column-header-wrapper">
      <button
        class="column-header date-column"
        onclick={() => explorer.setSorting("modified")}
        class:active={explorer.sortBy === "modified"}
      >
        <span>Date modified</span>
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
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("date", e)}></div>
    </div>
    {/if}
    {#if settingsStore.columnVisibility.type}
    <div class="column-header-wrapper">
      <div class="column-header type-column">
        <span>Type</span>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("type", e)}></div>
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
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="column-resize-handle" onmousedown={(e) => columnResize.startResize("size", e)}></div>
    </div>
    {/if}
  </div>

  <!-- Column visibility context menu -->
  {#if columnMenuPos}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="column-menu-backdrop" onclick={closeColumnMenu} oncontextmenu={(e) => { e.preventDefault(); closeColumnMenu(); }}></div>
    <div class="column-menu" style="left: {columnMenuPos.x}px; top: {columnMenuPos.y}px;">
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
    </div>
  {/if}

  {#if explorer.isCreatingFolder}
    <InlineNewFolder {explorer} variant="details" />
  {/if}

  <VirtualList
    items={explorer.displayEntries}
    itemHeight={32}
    getKey={(entry) => entry.path}
  >
    {#snippet children(entry, index)}
      <FileItem
        {entry}
        {explorer}
        onclick={(event) => onitemclick(entry, event)}
        ondblclick={() => onitemdblclick(entry)}
        selected={explorer.isSelected(entry)}
      />
    {/snippet}
  </VirtualList>
</div>

<style>
  .details-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: fit-content;
  }

  .column-headers {
    display: grid;
    gap: 0;
    padding: 6px 16px;
    background: var(--background-solid);
    border-bottom: 1px solid var(--divider);
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
    z-index: 10;
  }

  .column-resize-handle:hover,
  .details-view.resizing .column-resize-handle {
    background: var(--accent);
    opacity: 0.3;
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
    transition: all var(--transition-fast);
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
    color: var(--accent);
    font-size: 12px;
  }
</style>
