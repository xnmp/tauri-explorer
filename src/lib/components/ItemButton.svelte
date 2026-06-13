<!--
  ItemButton - Shared entry button wrapper with drag-drop and interaction handler wiring.
  Eliminates duplicated event handlers and class bindings across ListView and TilesView.
  Issue: #109
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import type { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import type { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { isInClipboard, isClipboardCut } from "$lib/composables/use-item-interactions.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { isMac } from "$lib/domain/platform";

  type ItemInteractions = ReturnType<typeof useItemInteractions>;
  type PointerDrag = ReturnType<typeof usePointerDrag>;

  interface Props {
    entry: FileEntry;
    explorer: ExplorerInstance;
    interactions: ItemInteractions;
    pointerDrag: PointerDrag | null;
    class?: string;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
    children: Snippet;
  }

  let {
    entry,
    explorer,
    interactions,
    pointerDrag,
    class: className = "",
    onitemclick,
    onitemdblclick,
    children,
  }: Props = $props();

  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);
</script>

<button
  class="{className} entry-item"
  data-path={entry.path}
  class:directory={entry.kind === "directory"}
  class:selected={explorer.isSelected(entry)}
  class:cut={isClipboardCut(entry)}
  class:in-clipboard={isInClipboard(entry)}
  class:hidden-entry={entry.name.startsWith(".") || manualHiddenStore.isHidden(explorer.currentPath, entry.name)}
  class:empty-folder={entry.kind === "directory" && entry.is_empty === true}
  class:drop-target={interactions.isDropTarget(entry.path)}
  class:copy-drop={interactions.isCopyDrop(entry.path)}
  draggable={!isMac}
  onclick={(e) => onitemclick(entry, e)}
  ondblclick={() => { if (!isRenaming) onitemdblclick(entry); }}
  oncontextmenu={(e) => interactions.handleContextMenu(e, entry)}
  ondragstart={!isMac ? (e) => interactions.handleDragStart(e, entry, explorer.isSelected(entry)) : undefined}
  ondragend={!isMac ? interactions.handleDragEnd : undefined}
  ondragover={(e) => interactions.handleDragOver(e, entry)}
  ondragleave={() => interactions.handleDragLeave(entry)}
  ondrop={(e) => interactions.handleDrop(e, entry)}
  onmousedown={isMac ? (e) => { e.stopPropagation(); pointerDrag!.handlePointerDown(e, entry, explorer.isSelected(entry)); } : undefined}
>
  {@render children()}
  {#if entry.is_symlink && !isRenaming}
    <div class="symlink-badge" title={entry.symlink_target ? `Link to ${entry.symlink_target}` : "Symbolic link"}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M7 3L3 7M3 3L3 7L7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  {/if}
</button>

<style>
  /* Symlink badge — mirrors the Details view (FileItem) indicator */
  .symlink-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--text-tertiary);
    flex-shrink: 0;
    opacity: 0.7;
  }
</style>
