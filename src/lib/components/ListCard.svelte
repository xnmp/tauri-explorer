<!--
  An open top-level folder in the List column flow (#1240): the descendants'
  scroll area below the folder's own (fixed) header row, plus "+N more". The
  header, the slot, the card box and the grip (ListCardGrip, inside the
  header treeitem) belong to ListColumnsView, so the header keeps its DOM node
  when the folder opens or closes. Layout, clamp and scroll-edge policies are
  pure (list-cards.ts); scroll offsets and the grip preview live in
  useListColumns.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { PeekGroup, PeekRow } from "$lib/domain/folder-peek";
  import { LIST_SLOT_HEIGHT, type ListCardSpec } from "$lib/domain/list-column-flow";
  import { cardFades, LIST_CARD_FADE } from "$lib/domain/list-cards";
  import type { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import { isPeekClaimed, resolveDropTargetFromElement } from "$lib/composables/use-native-drop-target.svelte";
  import { createSurfaceDropFeedback, surfaceDropPath } from "$lib/composables/surface-drop-feedback";

  import ListPeekState from "./ListPeekState.svelte";

  type EntryRow = Extract<PeekRow, { kind: "entry" }>;

  interface Props {
    /** The card's folder (its header row). */
    entry: FileEntry;
    /** The group's id, which the header treeitem owns (aria-owns). */
    id: string;
    card: ListCardSpec;
    /** The pane's peek rows; the card shows `rows[card.start, card.end)`. */
    rows: readonly PeekRow[];
    groups: readonly PeekGroup[];
    carets: boolean;
    /** Content offsets to mount (window, overscan and pinned editors). */
    offsets: readonly number[];
    scrollTop: number;
    /** Rows shown while the grip is dragged, else null. */
    previewRows: number | null;
    interactions: ReturnType<typeof useItemInteractions>;
    onscrolltop: (top: number) => void;
    row: Snippet<[EntryRow]>;
  }
  let { entry, id, card, rows, groups, carets, offsets, scrollTop, previewRows, interactions, onscrolltop, row }: Props = $props();

  const content = $derived(card.end - card.start);
  const visible = $derived(previewRows ?? card.visibleRows);
  const fades = $derived(cardFades(content, visible, scrollTop));
  // Nested levels get only a guide line, centred under their header's caret
  // (or, with carets off, its folder icon).
  const guides = $derived(groups.filter(group => group.depth > 0 && group.startRow >= card.start && group.endRow <= card.end && group.endRow > group.startRow));
  // Plain each items (no {@const}): handlers may read a row after its block is gone.
  const mounted = $derived(offsets.flatMap(offset => {
    const item = rows[card.start + offset];
    return item ? [{ offset, row: item }] : [];
  }));
  const shownGuides = $derived.by(() => {
    const first = offsets[0] ?? 0, last = offsets.at(-1) ?? -1;
    return guides.flatMap(group => {
      const top = group.startRow - card.start, bottom = group.endRow - card.start;
      if (bottom <= first || top > last + 1) return [];
      const height = (bottom - top) * LIST_SLOT_HEIGHT;
      return [{ path: group.path, top: top * LIST_SLOT_HEIGHT - 3, height: height - 5, depth: group.depth, fade: Math.min(64, height * 0.6) }];
    });
  });
  // Directories inside the card, for drops on their pseudo-rows.
  const folders = $derived.by(() => {
    const byPath = new Map<string, FileEntry>([[entry.path, entry]]);
    for (const group of guides) {
      const header = rows[group.startRow - 1];
      if (header?.kind === "entry") byPath.set(header.entry.path, header.entry);
    }
    return byPath;
  });

  let scroller = $state<HTMLElement | null>(null);
  // Apply programmatic offsets (keyboard reveal, remount). Native scrolling
  // reports back through onscroll, so this never fights the user.
  $effect(() => {
    const top = scrollTop;
    if (scroller && Math.abs(scroller.scrollTop - top) > 0.5) scroller.scrollTop = top;
  });

  /** The folder a drop or menu on the card's own surface (not a row) targets. */
  function surfaceTarget(event: Event): FileEntry | null {
    if (isPeekClaimed(event)) {
      const target = resolveDropTargetFromElement(event.target as Element | null);
      return target?.type === "folder" ? folders.get(target.path) ?? null : null;
    }
    const path = surfaceDropPath(event.target, entry.path);
    return path === null ? null : folders.get(path) ?? entry;
  }
  const surface = createSurfaceDropFeedback(() => interactions, surfaceTarget);
</script>

<div class="list-card-body">
  <div class="list-card-scroll peek-drop-target" data-card-scroll data-marquee-clip data-path={entry.path}
    {id} role="group" aria-label={`${entry.name} contents`} tabindex="-1"
    style:--card-visible-rows={visible}
    style:--fade-top={`${fades.top ? LIST_CARD_FADE : 0}px`}
    style:--fade-bottom={`${fades.bottom ? LIST_CARD_FADE : 0}px`}
    bind:this={scroller}
    onscroll={() => { if (scroller) onscrolltop(scroller.scrollTop); }}
    ondragenter={surface.over} ondragover={surface.over} ondragleave={surface.leave} ondrop={surface.drop}
    oncontextmenu={(event) => { const folder = surfaceTarget(event); if (folder) interactions.handleContextMenu(event, folder); }}>
    <div class="list-card-content" style:height={`${content * LIST_SLOT_HEIGHT}px`}>
      {#each shownGuides as guide (guide.path)}
        <span class="list-guide" aria-hidden="true"
          style:top={`${guide.top}px`} style:height={`${guide.height}px`}
          style:left={`${(carets ? 17.25 : 18.25) + guide.depth * 16}px`}
          style:background-image={`linear-gradient(to bottom, var(--accent), var(--divider) ${guide.fade}px)`}></span>
      {/each}
      {#each mounted as slot (slot.row.key)}
        <div class="list-row" style:top={`${slot.offset * LIST_SLOT_HEIGHT}px`} style:--depth={slot.row.kind === "create" ? 0 : slot.row.depth}>
          {#if slot.row.kind === "entry"}
            {@render row(slot.row)}
          {:else if slot.row.kind === "peek-state"}
            <ListPeekState row={slot.row} {carets} />
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .list-card-body { position: relative; }
  .list-card-scroll {
    position: relative;
    height: calc(var(--card-visible-rows) * 30px);
    overflow-x: hidden;
    overflow-y: auto;
    overflow-anchor: none;
    scrollbar-width: thin;
    border-radius: 0 0 8px 8px;
    mask-image: linear-gradient(to bottom, transparent, #000 var(--fade-top), #000 calc(100% - var(--fade-bottom)), transparent);
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 var(--fade-top), #000 calc(100% - var(--fade-bottom)), transparent);
  }
  .list-card-content { position: relative; }
  .list-row { position: absolute; left: 0; right: 0; height: 30px; }
  .list-guide { position: absolute; width: 1.5px; pointer-events: none; }
</style>
