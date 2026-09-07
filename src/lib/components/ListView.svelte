<!--
  ListView - Compact multi-column list view.

  DOM-virtualized by ROW (#128): entries are chunked row-major into rows of
  `effectiveListColumns`, and each row is one fixed-height VirtualList item, so
  only the visible rows live in the DOM. This changed the fill order from the
  old column-flow (down-then-across) to row-major (across-then-down); the DOM
  stays in sequence order so the list remains name-sorted.
  Issue: tauri-explorer-9djf.5, #128
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { useRowGridView } from "$lib/composables/use-row-grid-view.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getFileIconColor } from "$lib/domain/file-types";

  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import InlineNewFolder, { isNewFolderSentinel } from "./InlineNewFolder.svelte";
  import ItemButton from "./ItemButton.svelte";
  import VirtualList from "./VirtualList.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    contentWidth: number;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
    /** Scroll the given displayEntries index into view (bound by FileList). */
    scrollToIndex?: (index: number) => void;
  }

  let { explorer, contentWidth, onitemclick, onitemdblclick, scrollToIndex = $bindable() }: Props = $props();

  // Fixed row height: a single-line list item (16px icon / one text line +
  // 4px vertical padding + border) plus the 4px inter-row gap. List names are
  // `white-space: nowrap`, so every row is exactly this tall.
  const LIST_ROW_HEIGHT = 30;

  // Compute effective list column count (auto or fixed)
  const effectiveListColumns = $derived.by(() => {
    if (settingsStore.listViewColumns > 0) return settingsStore.listViewColumns;
    if (contentWidth <= 0) return 1;
    return Math.max(1, Math.min(6, Math.floor(contentWidth / settingsStore.listColumnMaxWidth)));
  });

  // Shared row-grid wiring (interactions, pointer drag, sentinel splice,
  // row chunking, scrollToIndex mapping) — see useRowGridView.
  const grid = useRowGridView({
    getExplorer: () => explorer,
    refreshPanes: () => windowTabsManager.refreshAllPanes(),
    getColumns: () => effectiveListColumns,
  });
  const { interactions, pointerDrag } = grid;
  scrollToIndex = grid.scrollToIndex;
</script>

<div class="list-view" data-columns={effectiveListColumns}>
  <VirtualList
    class="list-scroller file-rows"
    items={grid.rows}
    itemHeight={LIST_ROW_HEIGHT}
    itemOverflow="visible"
    viewportPadding="6px 8px"
    getKey={(row) => row.startIndex}
    bind:scrollToIndex={grid.rowScrollToIndex}
  >
    {#snippet children(row)}
      <div class="list-row" style="grid-template-columns: repeat({effectiveListColumns}, minmax(0, 1fr));">
        {#each row.items as entry, col (entry.path)}
          {#if isNewFolderSentinel(entry)}
            <InlineNewFolder {explorer} variant="list" />
          {:else}
          <ItemButton class="list-item" index={row.startIndex + col - grid.sentinelOffset} {entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}>
            <span class="list-icon" data-drag-icon style:color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined}>
              <FileIcon {entry} size="small" />
            </span>
            <span data-drag-name><EntryName {entry} {explorer} variant="list" /></span>
            <GitStatusBadge entryName={entry.name} />
          </ItemButton>
          {/if}
        {/each}
      </div>
    {/snippet}
  </VirtualList>
</div>

<style>
  .list-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* Each virtualized row is an equal-width grid. minmax(0, 1fr), not 1fr: a
     1fr track's implicit min is min-content, so a long unbreakable name (or the
     wider rename box) would expand its column and shove the others sideways. A
     0 min keeps every column an equal share and lets the name truncate / the
     rename box overflow instead. */
  .list-view :global(.list-row) {
    display: grid;
    gap: 4px;
    align-items: start;
  }

  .list-view :global(.list-item) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-left-width: var(--selection-indicator-width);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
  }

  .list-view :global(.list-item:focus) {
    outline: none;
  }

  .list-view :global(.list-item:hover) {
    background: var(--subtle-fill-secondary);
  }

  .list-view :global(.list-item.selected) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
  }

  .list-view :global(.list-item.cut) {
    opacity: 0.5;
  }

  .list-view :global(.list-item.hidden-entry) {
    opacity: 0.55;
  }

  .list-view :global(.list-item.empty-folder) {
    opacity: 0.55;
  }

  .list-view :global(.list-item.empty-folder:hover),
  .list-view :global(.list-item.empty-folder.selected) {
    opacity: 0.8;
  }

  .list-view :global(.list-item.in-clipboard:not(.cut)) {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }

  .list-view :global(.list-item.drop-target) {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .list-view :global(.list-item.drop-target.copy-drop) {
    background: color-mix(in srgb, var(--system-success) 15%, transparent);
    box-shadow: inset 0 0 0 1px var(--system-success);
  }

  .list-view :global(.list-icon) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  /* Name and rename styles are handled by EntryName component */

  /* Let the name fill (and truncate within) its share of the row; min-width:0
     is what actually allows it to shrink below the text's intrinsic width. */
  .list-view :global(.list-item > [data-drag-name]) {
    flex: 1;
    min-width: 0;
  }

  /* While renaming, let the content-width rename box extend past the item over
     neighbouring columns instead of being clipped to its grid cell. The parent
     grid cell and virtual row must also allow the overflow. */
  .list-view :global(.list-item:has(.rename-input)) {
    overflow: visible;
    z-index: 2;
  }
</style>
