<!-- List fills fixed-width columns from top to bottom and virtualizes sideways. -->
<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { useListColumns } from "$lib/composables/use-list-columns.svelte";
  import { useListMotion } from "$lib/composables/use-list-motion.svelte";
  import { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { usesPointerDrag } from "$lib/domain/platform";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import type { ListCardSpec, ListNavigationSnapshot, ListSpillMore } from "$lib/domain/list-column-flow";
  import { LIST_COLUMN_STRIDE, LIST_PADDING_X, LIST_SLOT_HEIGHT } from "$lib/domain/list-column-flow";
  import { cardMoreCount, listMoreExpansion } from "$lib/domain/list-cards";
  import { peekTreePositionLookup, type PeekRow } from "$lib/domain/folder-peek";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import { getFileIconColor } from "$lib/domain/file-types";
  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";
  import EntryCell from "./EntryCell.svelte";
  import ListCard from "./ListCard.svelte";
  import ListPeekState from "./ListPeekState.svelte";
  import ListLineageGroup from "./ListLineageGroup.svelte";
  import ListCardGrip from "./ListCardGrip.svelte";
  import PeekOpenButton from "./PeekOpenButton.svelte";
  import type { FileEntry } from "$lib/domain/file";

  type EntryRow = Extract<PeekRow, { kind: "entry" }>;

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
  const paneId = getPaneIdContext();
  const interactions = useItemInteractions({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes(), selectOnContextMenu: true });
  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes() }) : null;
  // A card's group is a sibling of its header treeitem, which owns it.
  const uid = $props.id();
  const cardGroupId = (entryIndex: number) => `${uid}-card-${entryIndex}`;
  const columns = useListColumns({
    getRows: () => explorer.detailRows,
    getFullFlowPaths: () => explorer.listFullFlowPaths,
    getColumnPaths: () => explorer.listColumnPaths,
    getSpillPaths: () => explorer.listSpillPaths,
    getPreferredRows: path => explorer.listCardRows(path),
    getSpringPaths: () => explorer.springPeeks,
    getPinnedPaths: () => dialogStore.renamingEntry ? [dialogStore.renamingEntry.path] : [],
    commitCardRows: (path, rows) => explorer.setListCardRows(path, rows),
    onviewportscroll: () => onviewportscroll?.(),
    onlayoutchange: () => onlayoutchange?.(),
  });
  let canvas = $state<HTMLElement | null>(null);
  let layer = $state<HTMLElement | null>(null);
  useListMotion({
    getModel: () => columns.model,
    // A drag's temporary card animates but is revealed only when it started
    // the next column: scrolling would otherwise move its header out from
    // under the held pointer; a wrapped card's bridges keep it inside (#1242).
    getChange: () => { const change = explorer.peekChange; return change?.temporary ? { ...change, reveal: columns.springWrapped(change.path) } : change; },
    getStatus: path => explorer.peekStatus(path),
    columnVisible: column => columns.columnVisible(column),
    getCanvas: () => canvas,
    getLayer: () => layer,
    revealCard: (path, smooth) => columns.revealCard(path, smooth),
  });
  const carets = $derived(explorer.peekCaretsShown);
  const moreCount = (card: ListCardSpec) => explorer.listColumnPaths.has(card.path)
    ? Math.max(0, card.end - card.start - card.visibleRows)
    : cardMoreCount(card.end - card.start,
      columns.previewRows(card.path) ?? card.visibleRows, columns.cardScrollTop(card.path));
  const moreStage = (card: ListCardSpec) => listMoreExpansion(explorer.listColumnPaths.has(card.path) ? "column" : "card");
  /** Every expanded stage's Less returns to the compact card (#1360, #1365), or null when it shows none. */
  function lessStage(row: EntryRow): "card" | null {
    const path = row.entry.path;
    if (row.depth !== 0 || !row.expanded || explorer.isSpringPeek(path)) return null;
    return explorer.listFullFlowPaths.has(path) || explorer.listSpillPaths.has(path) || explorer.listColumnPaths.has(path) ? "card" : null;
  }
  /** A spill's last slot shows every row (#1365). Focus moves to the row that
   * takes the slot, so the keyboard continues where the button was without a
   * sideways scroll back to the header. */
  async function showAll(more: ListSpillMore): Promise<void> {
    if (paneId) windowTabsManager.setActivePane(paneId);
    explorer.showAllListChildren(more.path);
    await tick();
    canvas?.querySelector<HTMLElement>(`.entry-item[data-index="${explorer.detailRows.rowToEntry[more.rowIndex]}"]`)?.focus({ preventScroll: true });
  }
  async function expandList(event: MouseEvent, path: string, stage: "card" | "column" | "spill" | "full"): Promise<void> {
    if (paneId) windowTabsManager.setActivePane(paneId);
    // The action changes with its stage; its stable header retains
    // keyboard focus so the next navigation key still belongs to this tree.
    (event.currentTarget as HTMLElement).closest<HTMLElement>(".entry-item")?.focus({ preventScroll: true });
    const directory = explorer.currentPath;
    if (stage === "full") explorer.showAllListChildren(path);
    else if (stage === "spill") explorer.showSpillListChildren(path);
    else if (stage === "column") explorer.showColumnListChildren(path);
    else explorer.showCompactListCard(path);
    await tick();
    if (explorer.currentPath === directory) {
      const index = explorer.displayEntries.findIndex(entry => entry.path === path);
      if (index >= 0) columns.revealEntry(index);
    }
  }
  // With peek on, rows are a tree: levels, expanded folders and caret buttons
  // are not allowed on listbox options (axe aria-allowed-attr, nested-interactive).
  const tree = $derived(explorer.peekEnabled ? peekTreePositionLookup(explorer.detailRows) : null);
  const revealIndex = (index: number) => columns.revealEntry(index);
  const contains = (index: number) => columns.containsEntry(index);
  const navigation = () => ({ entries: explorer.displayEntries, directory: explorer.currentPath, model: columns.model, usableWidth: columns.usableWidth, cardScrollTop: columns.cardScrollTop });
  scrollToIndex = revealIndex;
  containsIndex = contains;
  getNavigation = navigation;
  onDestroy(() => {
    // The incoming view can install its bindings before the outgoing view dies.
    if (getNavigation === navigation) getNavigation = undefined;
    if (containsIndex === contains) containsIndex = undefined;
    if (scrollToIndex === revealIndex) scrollToIndex = undefined;
  });
  $effect(() => { if (explorer.isCreatingFolder) columns.revealItem(0); });
</script>

{#snippet entryRow(row: EntryRow, card?: ListCardSpec | null)}
  <EntryCell role={tree ? "treeitem" : "option"} setSize={tree ? tree.setsize(row.entryIndex) : explorer.displayEntries.length} posInSet={tree?.posinset(row.entryIndex)}
    column={1} class="list-item list-entry" index={row.entryIndex} entry={row.entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}
    level={tree ? row.depth + 1 : undefined} owns={card && tree ? cardGroupId(row.entryIndex) : undefined}
    expanded={tree && explorer.canPeekEntry(row.entry) ? row.expanded : undefined}>
    {#if carets && explorer.canPeekEntry(row.entry)}
      <!-- A pointer affordance only (as in Details): never a tab stop, and its
           mousedown keeps focus where it was. Positioned in the row's caret
           gutter, so file rows need no blank slot element. -->
      <!-- The chevron is the button's ::before (one element per folder row). -->
      <button class="peek-caret" type="button" draggable={false} tabindex="-1"
        aria-expanded={row.expanded} aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.entry.name}`}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => {
          if (paneId) windowTabsManager.setActivePane(paneId);
          void explorer.togglePeek(row.entry.path);
        }}></button>
    {/if}
    <span class="list-icon" data-drag-icon style:color={row.entry.kind !== "directory" ? getFileIconColor(row.entry) : undefined}><FileIcon entry={row.entry} size="small" /></span>
    <span data-drag-name><EntryName entry={row.entry} {explorer} variant="list" bold={row.expanded} /></span>
    <GitStatusBadge directory={row.parentPath} entryName={row.entry.name} />
    {#if explorer.rowClickOwnsPeek(row.entry) && dialogStore.renamingEntry?.path !== row.entry.path}
      <PeekOpenButton entry={row.entry} {explorer} />
    {/if}
    {#if lessStage(row) === "card"}
      <!-- Expanded stages have no grip: Less is their way back to the card (#1360, #1365). -->
      <button class="list-card-more list-card-less" type="button" draggable={false}
        aria-label={`Shrink ${row.entry.name} to a card`} title="Return to a resizable card"
        onclick={(event) => expandList(event, row.entry.path, "card")}>Less</button>
    {/if}
    {#if card && card.end > card.start}
      <!-- Inside the folder's treeitem (a tree owns only groups and treeitems),
           positioned on the card's bottom edge against the slot. -->
      {#if !explorer.listColumnPaths.has(card.path) || explorer.isSpringPeek(card.path)}
        <ListCardGrip name={row.entry.name} rows={columns.previewRows(card.path) ?? card.visibleRows} max={columns.gripMax(card.path)}
          dragging={columns.previewRows(card.path) !== null}
          onstart={(pointer, y) => columns.beginGrip(card.path, pointer, y)} onkey={(key) => columns.gripKey(card.path, key)} />
      {/if}
      {#if moreCount(card) > 0 && !explorer.isSpringPeek(card.path)}
        <button class="list-card-more" type="button" draggable={false}
          aria-label={moreStage(card) === "spill" ? `Show more ${row.entry.name} items` : `Show all ${row.entry.name} items`}
          title={moreStage(card) === "spill" ? "Show more rows below the folder" : "Show all items across columns"}
          onclick={(event) => expandList(event, card.path, moreStage(card))}>+{moreCount(card)} more</button>
      {/if}
    {/if}
  </EntryCell>
{/snippet}

<div class="list-view" class:carets data-rows={columns.rows}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- tree and listbox are both interactive composites; the check cannot resolve a dynamic role. -->
  <div class="virtual-viewport list-scroller file-rows" class:short={columns.short}
    role={tree ? "tree" : "listbox"} aria-label="Files" aria-multiselectable="true" tabindex={fallbackTabStop ? 0 : -1}
    use:columns.attach>
    <div class="list-measure" aria-hidden="true"></div>
    <div class="list-canvas" bind:this={canvas} style:width="{columns.extent - LIST_PADDING_X * 2}px" style:height="{columns.rows * LIST_SLOT_HEIGHT}px">
      <!-- Plain each items, not {@const}/destructured deriveds: a rename input's
           blur can read its row after a commit has destroyed the slot. -->
      {#each columns.fullFlowGuides as guide (`${guide.path}:${guide.column}`)}
        <span class="list-flow-guide" aria-hidden="true"
          style:left={`${guide.column * LIST_COLUMN_STRIDE + (carets ? 17.25 : 18.25) + guide.depth * 16}px`}
          style:top={`${guide.top}px`} style:height={`${guide.height}px`}
          style:background-image={`linear-gradient(to bottom, var(--accent), var(--divider) ${Math.min(64, guide.height * 0.6)}px)`}></span>
      {/each}
      {#each columns.visibleItems as slot (slot.item.key)}
        <div class="list-slot list-place" class:list-card-box={!!slot.item.card} class:covered={columns.isCovered(slot.item.key)}
          data-motion-key={slot.item.key} data-column={slot.placement.column}
          data-row-path={slot.header?.entry.path ?? slot.state?.parentPath ?? slot.item.more?.path}
          data-row-kind={slot.header ? slot.header.entry.kind === "directory" ? "directory" : "file" : slot.state || slot.item.more ? "state" : undefined}
          style:left="{slot.placement.column * LIST_COLUMN_STRIDE}px" style:top="{slot.placement.row * LIST_SLOT_HEIGHT}px"
          style:--depth={slot.header?.depth ?? (slot.item.more ? 1 : 0)}>
          {#if slot.state}
            <ListPeekState row={slot.state} {carets} />
          {:else if slot.group}
            <ListLineageGroup row={slot.group} {carets} {explorer} />
          {:else if slot.item.more}
            <!-- A spill's last slot (#1365): a drop on it goes into its folder,
                 like the folder's status rows. -->
            <div class="list-spill-more peek-drop-target" class:carets data-path={slot.item.more.path}
              role="treeitem" aria-level={2} aria-selected="false">
              <button class="list-card-more list-spill-more-button" type="button" draggable={false}
                aria-label={`Show all ${slot.item.more.path.split(/[\\/]/).at(-1)} items`} title="Show all items across columns"
                onclick={() => showAll(slot.item.more!)}>+{slot.item.more.count} more</button>
            </div>
          {:else if !slot.header}
            <InlineNewFolder {explorer} variant="list" columns />
          {:else}
            {@render entryRow(slot.header, slot.item.card)}
            {#if slot.item.card}
              <ListCard entry={slot.header.entry} id={cardGroupId(slot.header.entryIndex)} card={slot.item.card} rows={explorer.detailRows.rows} groups={explorer.detailRows.groups} {carets}
                offsets={columns.cardOffsets(slot.item.card)} scrollTop={columns.cardScrollTop(slot.item.card.path)} previewRows={columns.previewRows(slot.item.card.path)}
                {interactions} row={entryRow} {explorer}
                onscrolltop={(top) => columns.setCardScrollTop(slot.item.card!.path, top)} />
            {/if}
          {/if}
        </div>
      {/each}
      {#each columns.springBridges as bridge (`${bridge.path}:${bridge.left}:${bridge.top}`)}
        <!-- Inside a temporary card that started the next column: the slot it
             left, the rows below it and the gap between (#1242, list-cards.ts). -->
        <div class="list-spring-bridge" data-spring-bridge={bridge.path} aria-hidden="true"
          style:left="{bridge.left}px" style:top="{bridge.top}px" style:width="{bridge.width}px" style:height="{bridge.height}px"></div>
      {/each}
      <div class="list-motion-layer" bind:this={layer} aria-hidden="true" inert></div>
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
  .list-measure { width: 100%; height: 0; pointer-events: none; }
  .list-canvas { position: relative; }
  /* Look classes only (list-place, list-card-box, list-entry): motion ghosts
     keep these but lose every identity class, so they look the same while no
     live query can reach them. */
  .list-place { position: absolute; width: 260px; height: 30px; }
  .list-place.covered { visibility: hidden; }
  .list-flow-guide { position: absolute; width: 1.5px; pointer-events: none; }
  .list-spring-bridge { position: absolute; z-index: 3; }
  .list-motion-layer { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
  /* Idle, the layer must not exist for hit testing: axe reads an empty
     full-canvas overlay as covering every row's text. */
  .list-motion-layer:empty { display: none; }

  /* Open folders remain layout groups; indentation and guide lines convey
     their hierarchy without surrounding panel chrome (#1311). */
  .list-place.list-card-box { height: auto; isolation: isolate; }

  /* Not positioned: absolute row controls (caret, card grip) resolve against
     the row's slot (.list-place, or a card's .list-row), so a header's grip
     can sit on its card's bottom edge. */
  .list-view :global(.list-entry) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 4px calc(8px + var(--depth, 0) * 16px);
    width: 100%;
    box-sizing: border-box;
    height: 26px;
    /* Centred in its 30px slot (a slot is a BFC, so nothing collapses). */
    margin: 2px 0;
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
     renderer’s styles arrive after the shared surface; pointer-focus resets
     never match :focus-visible. */
  .list-view :global(.list-entry:where(:focus:not(:focus-visible))) {
    outline: none;
  }

  .list-view :global(.list-entry:where(:hover:not(:has(.list-card-grip:hover, .list-card-more:hover)))) {
    background: var(--subtle-fill-secondary);
  }

  .list-view :global(.list-entry:where(.selected)) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-left-color: var(--accent);
  }

  /* Ghosted entries (hidden, empty folder, cut) dim their icon and quiet
     their label to --text-secondary. Dimming the whole row pulled the name
     below WCAG AA contrast in every theme (#785); Windows Explorer ghosts
     the icon for the same states. */
  .list-view :global(.list-entry:is(.hidden-entry, .empty-folder, .cut)) {
    color: var(--text-secondary);
  }

  .list-view :global(.list-entry:is(.hidden-entry, .empty-folder) [data-drag-icon]) {
    opacity: 0.55;
  }

  .list-view :global(.list-entry:is(.hidden-entry, .empty-folder):is(:hover, .selected) [data-drag-icon]) {
    opacity: 0.8;
  }

  .list-view :global(.list-entry.cut [data-drag-icon]) {
    opacity: 0.5;
  }

  .list-view :global(.list-entry:where(.in-clipboard:not(.cut))) {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }

  .list-view :global(.list-entry.drop-target) {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .list-view :global(.list-entry.drop-target.copy-drop) {
    background: color-mix(in srgb, var(--system-success) 15%, transparent);
    box-shadow: inset 0 0 0 1px var(--system-success);
  }

  /* A native drag over a card's own surface (or a pseudo-row) highlights it. */
  .list-view :global(.peek-drop-target.drop-target) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  /* The List "close" caret (spec §8.3): a 14px gutter with a 10px chevron about
     4px from the icon; every row keeps the gutter so names align, and the 16px
     indent puts a child's caret under its parent's icon. */
  .list-view.carets :global(.list-entry) {
    padding-left: calc(24px + var(--depth, 0) * 16px);
  }

  .list-view :global(.list-entry .peek-caret) {
    position: absolute;
    /* Against the slot: past the row's 2px margin, 1px border and indicator edge. */
    top: 5px;
    left: calc(var(--selection-indicator-width, 3px) + 8px + var(--depth, 0) * 16px);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  /* Details' 10px chevron (stroke 1.3, round caps), drawn as a mask so a
     folder row adds one element, not three; open rotates it to point down. */
  .list-view :global(.list-entry .peek-caret::before) {
    content: "";
    width: 10px;
    height: 10px;
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M3.5 2 6.5 5 3.5 8' fill='none' stroke='black' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 10px 10px no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M3.5 2 6.5 5 3.5 8' fill='none' stroke='black' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 10px 10px no-repeat;
  }

  .list-view :global(.list-entry .peek-caret[aria-expanded="true"]::before) {
    transform: rotate(90deg);
  }

  .list-view :global(.list-entry .peek-caret:hover) {
    background: var(--subtle-fill-tertiary);
    color: var(--text-primary);
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
  .list-view :global(.list-entry > [data-drag-name]) {
    flex: 1;
    min-width: 0;
  }

  .list-view:not(.carets) :global(.list-entry > .peek-open) {
    margin-left: auto;
  }

  .list-view :global(.list-entry:has(.peek-open) > [data-drag-name]) {
    flex: 0 1 auto;
  }

  .list-card-more {
    position: absolute;
    bottom: -7px;
    left: calc(50% + 30px);
    height: 18px;
    padding: 0 4px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 10px;
    line-height: 14px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
    z-index: 4;
  }
  .list-card-more:hover { background: var(--subtle-fill-tertiary); color: var(--text-primary); }
  .list-card-more:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .list-card-less { position: static; flex-shrink: 0; margin-left: auto; }
  .list-spill-more {
    height: 26px;
    margin: 2px 0;
    display: flex;
    align-items: center;
    padding-left: calc(11px + var(--depth) * 16px);
  }
  .list-spill-more.carets { padding-left: calc(27px + var(--depth) * 16px); }
  .list-spill-more-button { position: static; font-size: 12px; }


  /* While renaming, let the content-width rename box extend past the item over
     neighbouring columns instead of being clipped to its grid cell. The parent
     grid cell and virtual row must also allow the overflow. */
  .list-view :global(.list-entry:has(.rename-input)) {
    overflow: visible;
  }
  /* Entries are not positioned, so the renaming row's slot is what rises. */
  .list-view :global(:is(.list-place, .list-row):has(.rename-input)) {
    z-index: 2;
  }
</style>
