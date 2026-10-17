<!-- List fills fixed-width columns from top to bottom and virtualizes sideways. -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { useListColumns } from "$lib/composables/use-list-columns.svelte";
  import { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { usesPointerDrag } from "$lib/domain/platform";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import type { ListNavigationSnapshot } from "$lib/domain/list-column-flow";
  import { LIST_COLUMN_STRIDE, LIST_PADDING_X, LIST_SLOT_HEIGHT } from "$lib/domain/list-column-flow";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getFileIconColor } from "$lib/domain/file-types";
  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import InlineNewFolder, { NEW_FOLDER_SENTINEL, isNewFolderSentinel } from "./InlineNewFolder.svelte";
  import EntryCell from "./EntryCell.svelte";
  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
    scrollToIndex?: (index: number) => void;
    containsIndex?: (index: number) => boolean;
    getNavigation?: () => ListNavigationSnapshot;
    fallbackTabStop: boolean;
    onviewportscroll?: () => void;
    onlayoutchange?: () => void;
  }
  let { explorer, onitemclick, onitemdblclick, scrollToIndex = $bindable(), containsIndex = $bindable(), getNavigation = $bindable(), fallbackTabStop, onviewportscroll, onlayoutchange }: Props = $props();
  const interactions = useItemInteractions({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes(), selectOnContextMenu: true });
  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes() }) : null;
  const sentinelOffset = $derived(explorer.isCreatingFolder ? 1 : 0);
  const items = $derived(explorer.isCreatingFolder ? [NEW_FOLDER_SENTINEL, ...explorer.displayEntries] : explorer.displayEntries);
  const columns = useListColumns({
    getItems: () => items,
    getPinnedPaths: () => [explorer.isCreatingFolder ? NEW_FOLDER_SENTINEL.path : "", dialogStore.renamingEntry?.path ?? ""],
    onviewportscroll: () => onviewportscroll?.(),
    onlayoutchange: () => onlayoutchange?.(),
  });
  const revealIndex = (index: number) => columns.reveal(index + sentinelOffset);
  const contains = (index: number) => columns.containsIndex(index + sentinelOffset);
  const navigation = () => ({ entries: explorer.displayEntries, directory: explorer.currentPath, layout: columns.layout, sentinelOffset, usableWidth: columns.usableWidth });
  scrollToIndex = revealIndex;
  containsIndex = contains;
  getNavigation = navigation;
  onDestroy(() => {
    // The incoming view can install its bindings before the outgoing view dies.
    if (getNavigation === navigation) getNavigation = undefined;
    if (containsIndex === contains) containsIndex = undefined;
    if (scrollToIndex === revealIndex) scrollToIndex = undefined;
  });
  $effect(() => { if (explorer.isCreatingFolder) columns.reveal(0); });
</script>

<div class="list-view" data-rows={columns.rows}>
  <div class="virtual-viewport list-scroller file-rows" class:short={columns.short}
    role="listbox" aria-label="Files" aria-multiselectable="true" tabindex={fallbackTabStop ? 0 : -1}
    use:columns.attach>
    <div class="list-canvas" style:width="{columns.extent - LIST_PADDING_X * 2}px" style:height="{columns.rows * LIST_SLOT_HEIGHT}px">
      {#each columns.visibleItems as { entry, placement } (entry.path)}
        <div class="list-slot" data-column={placement.column} style:left="{placement.column * LIST_COLUMN_STRIDE}px" style:top="{placement.row * LIST_SLOT_HEIGHT}px">
          {#if isNewFolderSentinel(entry)}
            <InlineNewFolder {explorer} variant="list" />
          {:else}
            <EntryCell role="option" setSize={explorer.displayEntries.length} column={placement.column + 1} class="list-item" index={placement.index - sentinelOffset} {entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}>
              <span class="list-icon" data-drag-icon style:color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined}><FileIcon {entry} size="small" /></span>
              <span data-drag-name><EntryName {entry} {explorer} variant="list" /></span>
              <GitStatusBadge entryName={entry.name} />
            </EntryCell>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .list-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .list-scroller {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-x: scroll;
    overflow-y: hidden;
    padding: 6px 8px;
  }

  .list-scroller.short { overflow-y: auto; }
  .list-canvas { position: relative; }
  .list-slot { position: absolute; width: 260px; height: 30px; }

  .list-view :global(.list-item) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    width: 100%;
    box-sizing: border-box;
    height: 26px;
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

  /* View chrome must stay below FileList’s keyboard ring even when this
     renderer’s styles arrive after the shared surface. */
  .list-view :global(.list-item:where(:focus)) {
    outline: none;
  }

  .list-view :global(.list-item:where(:hover)) {
    background: var(--subtle-fill-secondary);
  }

  .list-view :global(.list-item:where(.selected)) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
  }

  /* Ghosted entries (hidden, empty folder, cut) dim their icon and quiet
     their label to --text-secondary. Dimming the whole row pulled the name
     below WCAG AA contrast in every theme (#785); Windows Explorer ghosts
     the icon for the same states. */
  .list-view :global(.list-item:is(.hidden-entry, .empty-folder, .cut)) {
    color: var(--text-secondary);
  }

  .list-view :global(.list-item:is(.hidden-entry, .empty-folder) [data-drag-icon]) {
    opacity: 0.55;
  }

  .list-view :global(.list-item:is(.hidden-entry, .empty-folder):is(:hover, .selected) [data-drag-icon]) {
    opacity: 0.8;
  }

  .list-view :global(.list-item.cut [data-drag-icon]) {
    opacity: 0.5;
  }

  .list-view :global(.list-item:where(.in-clipboard:not(.cut))) {
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
