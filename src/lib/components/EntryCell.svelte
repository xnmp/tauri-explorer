<!--
  EntryCell - Shared file-grid cell with drag-drop and interaction handler wiring.
  Owns roving focus attributes and eliminates duplicated event handlers and class bindings across ListView and TilesView.
  Issue: #109
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import type { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import type { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { useEntryAppearance } from "$lib/composables/use-entry-appearance.svelte";
  import EntrySymlinkBadge from "./EntrySymlinkBadge.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { usesPointerDrag, usesHtml5Drag } from "$lib/domain/platform";
  import { isVideoMediaFile } from "$lib/domain/file-types";

  type ItemInteractions = ReturnType<typeof useItemInteractions>;
  type PointerDrag = ReturnType<typeof usePointerDrag>;

  interface Props {
    entry: FileEntry;
    explorer: ExplorerInstance;
    interactions: ItemInteractions;
    pointerDrag: PointerDrag | null;
    class?: string;
    /** Global index in displayEntries — exposed as data-index so marquee
     *  selection maps a rendered (virtualized) tile/row back to its entry. */
    index?: number;
    column: number;
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
    index,
    column,
    onitemclick,
    onitemdblclick,
    children,
  }: Props = $props();

  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);

  const appearance = useEntryAppearance(() => entry, () => explorer.currentPath);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -- FileList owns cursor navigation; the window command router owns configurable Open/Preview and selection commands. -->
<div
  role="gridcell"
  aria-label={isVideoMediaFile(entry) ? `${entry.name}, video` : undefined}
  tabindex={!isRenaming && explorer.focusedEntry?.path === entry.path ? 0 : -1}
  aria-selected={explorer.isSelected(entry)}
  class="{className} entry-item"
  data-path={entry.path}
  data-index={index}
  aria-colindex={column}
  class:directory={entry.kind === "directory"}
  class:selected={explorer.isSelected(entry)}
  class:cut={appearance.cut}
  class:in-clipboard={appearance.inClipboard}
  class:hidden-entry={appearance.hidden}
  class:empty-folder={appearance.emptyFolder}
  class:drop-target={interactions.isDropTarget(entry.path)}
  class:copy-drop={interactions.isCopyDrop(entry.path)}
  draggable={usesHtml5Drag}
  onclick={(e) => onitemclick(entry, e)}
  ondblclick={() => { if (!isRenaming) onitemdblclick(entry); }}
  oncontextmenu={(e) => interactions.handleContextMenu(e, entry)}
  ondragstart={usesHtml5Drag ? (e) => interactions.handleDragStart(e, entry, explorer.isSelected(entry)) : undefined}
  ondragend={usesHtml5Drag ? interactions.handleDragEnd : undefined}
  ondragover={(e) => interactions.handleDragOver(e, entry)}
  ondragleave={(e) => interactions.handleDragLeave(e, entry)}
  ondrop={(e) => interactions.handleDrop(e, entry)}
  onmousedown={usesPointerDrag ? (e) => { e.stopPropagation(); pointerDrag!.handlePointerDown(e, entry, explorer.isSelected(entry)); } : undefined}
>
  {@render children()}
  <EntrySymlinkBadge {entry} renaming={isRenaming} />
</div>
