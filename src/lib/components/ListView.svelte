<!--
  ListView - Compact multi-column list view with CSS grid column-flow.
  Issue: tauri-explorer-9djf.5
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { useItemInteractions, isInClipboard, isClipboardCut } from "$lib/composables/use-item-interactions.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { getFileIconColor } from "$lib/domain/file-types";

  import { isMac } from "$lib/domain/platform";
  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    contentWidth: number;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
  }

  let { explorer, contentWidth, onitemclick, onitemdblclick }: Props = $props();

  const paneNav = getPaneNavigationContext();

  // Shared item interactions (DnD, context menu with select-on-right-click)
  const interactions = useItemInteractions({
    getExplorer: () => explorer,
    getPaneNav: () => paneNav,
    selectOnContextMenu: true,
  });

  const pointerDrag = isMac ? usePointerDrag({ getExplorer: () => explorer, getPaneNav: () => paneNav }) : null;

  // Compute effective list column count (auto or fixed)
  const effectiveListColumns = $derived.by(() => {
    if (settingsStore.listViewColumns > 0) return settingsStore.listViewColumns;
    if (contentWidth <= 0) return 1;
    return Math.max(1, Math.min(6, Math.floor(contentWidth / settingsStore.listColumnMaxWidth)));
  });

  const totalItems = $derived(explorer.displayEntries.length + (explorer.isCreatingFolder ? 1 : 0));
  const listRows = $derived(Math.ceil(totalItems / effectiveListColumns));
</script>

<div class="list-view file-rows" style="--list-columns: {effectiveListColumns}; --list-rows: {listRows};">
  {#if explorer.isCreatingFolder}
    <InlineNewFolder {explorer} variant="list" />
  {/if}
  {#each explorer.displayEntries as entry (entry.path)}
    <button
      class="list-item entry-item"
      data-path={entry.path}
      class:directory={entry.kind === "directory"}
      class:selected={explorer.isSelected(entry)}
      class:cut={isClipboardCut(entry)}
      class:in-clipboard={isInClipboard(entry)}
      class:hidden-entry={entry.name.startsWith(".") || manualHiddenStore.isHidden(explorer.currentPath, entry.name)}
      class:drop-target={interactions.isDropTarget(entry.path)}
      class:copy-drop={interactions.isCopyDrop(entry.path)}
      draggable={!isMac}
      onclick={(e) => onitemclick(entry, e)}
      ondblclick={() => onitemdblclick(entry)}
      oncontextmenu={(e) => interactions.handleContextMenu(e, entry)}
      ondragstart={!isMac ? (e) => interactions.handleDragStart(e, entry, explorer.isSelected(entry)) : undefined}
      ondragend={!isMac ? interactions.handleDragEnd : undefined}
      ondragover={(e) => interactions.handleDragOver(e, entry)}
      ondragleave={() => interactions.handleDragLeave(entry)}
      ondrop={(e) => interactions.handleDrop(e, entry)}
      onmousedown={isMac ? (e) => { e.stopPropagation(); pointerDrag!.handlePointerDown(e, entry, explorer.isSelected(entry)); } : undefined}
    >
      <span class="list-icon" style:color={entry.kind !== "directory" ? getFileIconColor(entry) : undefined}>
        <FileIcon {entry} size="small" />
      </span>
      <EntryName {entry} {explorer} variant="list" />
      <GitStatusBadge entryName={entry.name} />
    </button>
  {/each}
</div>

<style>
  .list-view {
    display: grid;
    grid-template-rows: repeat(var(--list-rows, 1), auto);
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 4px;
    padding: 8px;
    overflow-y: auto;
    flex: 1;
    align-content: start;
  }

  .list-item {
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
    transition: background var(--transition-fast);
  }

  .list-item:focus {
    outline: none;
  }

  .list-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .list-item.selected {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
  }

  .list-item.cut {
    opacity: 0.5;
  }

  .list-item.hidden-entry {
    opacity: 0.55;
  }

  .list-item.in-clipboard:not(.cut) {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }

  .list-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .list-item.drop-target.copy-drop {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
  }

  .list-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  /* Name and rename styles are handled by EntryName component */
</style>
