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
    /** A grid cell's aria-colindex; omitted where the grid's columns do not apply (a Tiles panel's mini tiles). */
    column?: number;
    /** "treeitem" inside a peek tree (List cards, #1240), whose rows carry
     *  level/expanded state that an "option" may not. */
    role?: "gridcell" | "option" | "treeitem";
    setSize?: number;
    /** A treeitem's position among its siblings; an option's is its index. */
    posInSet?: number;
    /** Peek tree depth + 1 (List cards, #1240); omitted outside a peek tree. */
    level?: number;
    /** A folder's peek state; omitted for files and outside a peek tree. */
    expanded?: boolean;
    /** The id of a group of this row's children rendered outside it (a List
     *  card's scroll area, #1240). The row is then named by its entry alone,
     *  not by its owned content. */
    owns?: string;
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
    role = "gridcell",
    setSize,
    posInSet,
    level,
    expanded,
    owns,
    onitemclick,
    onitemdblclick,
    children,
  }: Props = $props();

  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);

  const appearance = useEntryAppearance(() => entry, () => explorer.currentPath);
  // A peek caret, Open action or List card grip is its own control: never a
  // row click, double click or drag (mirrors FileItem).
  const isPeekControl = (event: Event) => event.target instanceof Element && !!event.target.closest(".peek-caret, .peek-open, .list-card-grip, .list-card-more");
  // dragstart targets the draggable row itself, not where the press began, so
  // a press on a control is noted when it starts.
  let pressedControl = false;
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- Roving composite focus is managed by FileList. -->
<!-- svelte-ignore a11y_click_events_have_key_events -- FileList owns cursor navigation; the window command router owns configurable Open/Preview and selection commands. -->
<div
  {role}
  aria-label={isVideoMediaFile(entry) ? `${entry.name}, video` : owns ? entry.name : undefined}
  aria-owns={owns}
  tabindex={!isRenaming && explorer.focusedEntry?.path === entry.path ? 0 : -1}
  aria-selected={explorer.isSelected(entry)}
  class="{className} entry-item"
  data-path={entry.path}
  data-index={index}
  aria-colindex={role === "gridcell" ? column : undefined}
  aria-posinset={role === "treeitem" ? posInSet : role === "option" && index !== undefined ? index + 1 : undefined}
  aria-setsize={role === "option" || role === "treeitem" ? setSize : undefined}
  aria-level={level}
  aria-expanded={expanded}
  class:directory={entry.kind === "directory"}
  class:selected={explorer.isSelected(entry)}
  class:cut={appearance.cut}
  class:in-clipboard={appearance.inClipboard}
  class:hidden-entry={appearance.hidden}
  class:empty-folder={appearance.emptyFolder}
  class:drop-target={interactions.isDropTarget(entry.path)}
  class:copy-drop={interactions.isCopyDrop(entry.path)}
  use:interactions.trackDragSource
  draggable={usesHtml5Drag}
  onclick={(e) => { if (!isPeekControl(e)) onitemclick(entry, e); }}
  ondblclick={(e) => { if (!isRenaming && !isPeekControl(e)) onitemdblclick(entry); }}
  oncontextmenu={(e) => interactions.handleContextMenu(e, entry)}
  onpointerdowncapture={(e) => { pressedControl = isPeekControl(e); }}
  ondragstart={usesHtml5Drag ? (e) => { if (pressedControl || isPeekControl(e)) e.preventDefault(); else interactions.handleDragStart(e, entry, explorer.isSelected(entry)); } : undefined}
  ondragend={usesHtml5Drag ? interactions.handleDragEnd : undefined}
  ondragenter={(e) => interactions.handleDragEnter(e, entry)}
  ondragover={(e) => interactions.handleDragOver(e, entry)}
  ondragleave={(e) => interactions.handleDragLeave(e, entry)}
  ondrop={(e) => interactions.handleDrop(e, entry)}
  onmousedown={usesPointerDrag ? (e) => { if (isPeekControl(e)) return; e.stopPropagation(); pointerDrag!.handlePointerDown(e, entry, explorer.isSelected(entry)); } : undefined}
>
  {@render children()}
  <EntrySymlinkBadge {entry} renaming={isRenaming} />
</div>
