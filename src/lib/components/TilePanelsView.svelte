<!--
  Tiles with Folder Peek on (#1241, spec §9): an open top-level folder shows
  its contents in a panel in a band above or below its grid row, or stacked
  under it. Each grid row and its bands is one variable-height VirtualList
  item, so a row's outlines and ribbons (which only ever join the row to its
  own bands) stay local to it. With no panel open the rows match the classic
  view (TilesView, which still renders Tiles with Folder Peek off).
  Layout, outlines, navigation and motion are pure (domain/tile-panel*.ts);
  scroll, preview, hover and motion state live in useTilePanels.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { autoFillColumns } from "$lib/domain/virtual-layout";
  import { tileLayout, TILE_GRID_PAD_X } from "$lib/domain/tile-layout";
  import type { GroupGeometry, PanelBox, TileGroup } from "$lib/domain/tile-panels";
  import type { TileNavigationSnapshot } from "$lib/domain/tile-panel-navigation";
  import { useTilePanels } from "$lib/composables/use-tile-panels.svelte";
  import { useTilesScrollJank, useUnavailableThumbs } from "$lib/composables/use-tile-view-support.svelte";
  import { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { usesPointerDrag } from "$lib/domain/platform";
  import { folderTileSize } from "$lib/state/folder-tile-size";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import EntryCell from "./EntryCell.svelte";
  import EntryName from "./EntryName.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";
  import TilePanel from "./TilePanel.svelte";
  import TilePanelGhost from "./TilePanelGhost.svelte";
  import TilePanelOutlines from "./TilePanelOutlines.svelte";
  import TileSurface from "./TileSurface.svelte";
  import TileVisual from "./TileVisual.svelte";
  import VirtualList from "./VirtualList.svelte";

  interface Props {
    explorer: ExplorerInstance;
    contentWidth: number;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
    scrollToIndex?: (index: number) => void;
    containsIndex?: (index: number) => boolean;
    /** Spatial arrow navigation while a panel is open (null otherwise). */
    getNavigation?: () => TileNavigationSnapshot | null;
    fallbackTabStop: boolean;
    onviewportscroll?: () => void;
    onlayoutchange?: () => void;
  }
  let {
    explorer, contentWidth, onitemclick, onitemdblclick, scrollToIndex = $bindable(), containsIndex = $bindable(),
    getNavigation = $bindable(), fallbackTabStop, onviewportscroll, onlayoutchange,
  }: Props = $props();

  const paneId = getPaneIdContext();
  const refreshPanes = () => windowTabsManager.refreshAllPanes();
  const interactions = useItemInteractions({ getExplorer: () => explorer, refreshPanes, selectOnContextMenu: true });
  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer: () => explorer, refreshPanes }) : null;

  const effectiveThumbnailSize = $derived(folderTileSize(explorer.currentPath));
  const layout = $derived(tileLayout(effectiveThumbnailSize));
  // The classic view's column count (the pane's content width, not the
  // scrollport's), so turning Folder Peek on or opening a panel never reflows.
  const columns = $derived(autoFillColumns(contentWidth - TILE_GRID_PAD_X, layout.gridMinWidth, layout.gap));

  let rootEl: HTMLDivElement | undefined = $state();
  const viewport = () => rootEl?.querySelector<HTMLElement>(".tiles-scroller") ?? null;
  const tiles = useTilePanels({
    getExplorer: () => explorer,
    getColumns: () => columns,
    getLayout: () => layout,
    getContentWidth: () => contentWidth,
    getViewport: viewport,
    onviewportscroll: () => onviewportscroll?.(),
    onlayoutchange: () => onlayoutchange?.(),
  });
  const model = $derived(tiles.model);
  const banded = $derived(model.panels.size > 0);
  // Grid counts and row indices hold only while the grid is uniform rows of
  // tiles, as in classic Tiles. Panels add label, tile and grip rows, and
  // side-by-side panels interleave theirs, so no row numbering is consistent:
  // the counts and indices are then omitted (panel tiles never take a colindex).
  const uniform = $derived(!banded && tiles.ghosts.size === 0);

  const thumbs = useUnavailableThumbs(() => explorer.currentPath);
  useTilesScrollJank(() => rootEl, () => ({ entries: explorer.displayEntries.length, thumbnailSize: effectiveThumbnailSize }));

  const revealIndex = (index: number) => tiles.revealEntry(index);
  const contains = (index: number) => tiles.containsEntry(index);
  const navigation = () => tiles.navigation();
  scrollToIndex = revealIndex;
  containsIndex = contains;
  getNavigation = navigation;
  onDestroy(() => {
    // The incoming view can install its bindings before the outgoing view dies.
    if (getNavigation === navigation) getNavigation = undefined;
    if (containsIndex === contains) containsIndex = undefined;
    if (scrollToIndex === revealIndex) scrollToIndex = undefined;
  });

  function toggle(path: string): void {
    if (paneId) windowTabsManager.setActivePane(paneId);
    void explorer.togglePeek(path);
  }

  /** Hover emphasis (#503: immediate): a parent tile, any part of its panel, or its ribbon. */
  function hover(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const owner = (target?.closest("[data-panel-owner]") as HTMLElement | SVGElement | null)?.dataset.panelOwner
      ?? target?.closest<HTMLElement>(".tile-item[data-path]")?.dataset.path;
    tiles.setHot(owner && model.panels.has(owner) ? owner : null);
  }

  /** An open folder's tile is its panel's tab, open on the panel's side. */
  const tabClass = (path: string): string => {
    const side = model.panels.get(path)?.side;
    return side === undefined ? "" : side === "above" ? " tab-above" : " tab-below";
  };

  /** A group the geometry has not caught up with yet: its row alone. */
  const NO_GEOMETRY: GroupGeometry = { height: 0, rowTop: 0, boxes: [] };
  const above = (boxes: readonly PanelBox[]) => boxes.filter(box => box.side === "above");
  const after = (boxes: readonly PanelBox[]) => boxes.filter(box => box.side !== "above");
</script>

{#snippet caret(entry: FileEntry)}
  {@const spec = model.panels.get(entry.path)}
  <!-- A pointer affordance only (as in Details and List): never a tab stop,
       and its mousedown keeps focus where it was. The chevron is the button's
       ::before, so a folder tile adds one element, not three. -->
  <button class="peek-caret tile-caret" type="button" draggable={false} tabindex="-1"
    class:open={!!spec} class:down={spec && spec.side !== "above"} class:up={spec?.side === "above"}
    aria-expanded={!!spec} aria-label={`${spec ? "Collapse" : "Expand"} ${entry.name}`}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => toggle(entry.path)}></button>
{/snippet}

<!-- A panel's tile: no caret (Tiles peeks top-level folders only) and no
     aria-colindex (the panel's columns are not the grid's). The grid's own
     tiles are written inline in the row, so a row costs what a classic row
     does plus the caret: no snippet block per tile. -->
{#snippet panelTile(entry: FileEntry, index: number)}
  <EntryCell class="tile-item tile-panel-item" {index} {entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}>
    <TileVisual {entry} {layout} videoUnavailable={thumbs.has(entry.path)} onvideounavailable={() => thumbs.mark(entry.path)}>
      {#snippet name()}<EntryName {entry} {explorer} variant="tiles" />{/snippet}
    </TileVisual>
    <GitStatusBadge entryName={entry.name} />
  </EntryCell>
{/snippet}

{#snippet panel(box: PanelBox)}
  {@const spec = model.panels.get(box.path)}
  {@const folder = spec ? explorer.displayEntries[spec.entryIndex] : undefined}
  {#if spec && folder}
    <TilePanel {box} {spec} {folder} entries={explorer.displayEntries} {layout} rowHeight={model.tile.rowHeight}
      bandHeight={tiles.bandExtent(box.path).height} gripBounds={tiles.gripBounds(box.path)}
      offsets={tiles.panelOffsets(box.path, box)} scrollTop={tiles.panelScrollTop(box.path)} dragging={tiles.gripping(box.path)}
      {interactions} tile={panelTile}
      onscrolltop={(top) => tiles.setPanelScrollTop(box.path, top)}
      ongripstart={(pointer, clientY) => tiles.beginGrip(box.path, pointer, clientY)}
      ongripkey={(key) => tiles.gripKey(box.path, key)}
      onclose={() => toggle(box.path)}
      onlabel={() => tiles.revealParent(box.path)} />
  {:else}
    {@const ghost = tiles.ghosts.get(box.path)}
    {#if ghost}<TilePanelGhost {box} {ghost} {layout} rowHeight={model.tile.rowHeight} />{/if}
  {/if}
{/snippet}

<TileSurface class="tiles-view tile-panels-view" fill {layout} bind:element={rootEl} data-columns={columns}
  style="--tile-caret-top: {layout.paddingTop + layout.displaySize - 17}px"
  onpointerover={hover} onpointerleave={() => tiles.setHot(null)}>
  <VirtualList
    class="tiles-scroller file-rows{banded ? ' banded' : ''}"
    role="grid" aria-label="Files" aria-multiselectable={true}
    aria-rowcount={uniform ? model.groups.length : undefined} aria-colcount={uniform ? columns : undefined}
    tabindex={fallbackTabStop ? 0 : -1}
    bind:containsIndex={tiles.rowContainsIndex}
    items={model.groups as TileGroup[]}
    itemHeight={layout.rowHeight}
    getItemHeight={(_group, index) => tiles.geometry[index]?.height ?? layout.rowHeight}
    itemOverflow="visible"
    viewportPadding="8px"
    getKey={(group) => group.key}
    onviewportsize={tiles.setViewportSize}
    {onviewportscroll}
    bind:scrollToOffset={tiles.scrollToOffset}
  >
    {#snippet children(group, g)}
      {@const geometry = tiles.geometry[g] ?? NO_GEOMETRY}
      <div class="tile-group">
        {#if geometry.boxes.length}
          <TilePanelOutlines {geometry} metrics={model.metrics} compact={tiles.compact} hot={tiles.hot} live={model.panels} bridged={explorer.springPeeks} />
          {#each above(geometry.boxes) as box (box.path)}{@render panel(box)}{/each}
        {/if}
        <div role="row" aria-rowindex={uniform ? g + 1 : undefined} class="tile-row"
          style="top: {geometry.rowTop}px; grid-template-columns: repeat({columns}, minmax(0, 1fr)); gap: var(--tile-gap);">
          {#each tiles.cells(group) as cell, col (cell.key)}
            {#if cell.entry === null || cell.index === null}
              <div role="gridcell"><InlineNewFolder {explorer} variant="tiles" /></div>
            {:else}
              <EntryCell column={col + 1} class="tile-item{tabClass(cell.entry.path)}" index={cell.index} entry={cell.entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}>
                <TileVisual entry={cell.entry} {layout} videoUnavailable={thumbs.has(cell.entry.path)} onvideounavailable={() => thumbs.mark(cell.entry!.path)}>
                  {#snippet name()}<EntryName entry={cell.entry!} {explorer} variant="tiles" bold={model.panels.has(cell.entry!.path)} />{/snippet}
                </TileVisual>
                {#if cell.entry.kind === "directory" && explorer.peekCaretsShown}{@render caret(cell.entry)}{/if}
                <GitStatusBadge entryName={cell.entry.name} />
              </EntryCell>
            {/if}
          {/each}
        </div>
        {#if geometry.boxes.length}
          {#each after(geometry.boxes) as box (box.path)}{@render panel(box)}{/each}
        {/if}
      </div>
    {/snippet}
  </VirtualList>
</TileSurface>

<style>
  /* No browser scroll anchoring: useTilePanels keeps the toggled row in place.
     While a band exists the scrollbar track stays, so the row width cannot
     oscillate with the content height. */
  :global(.tile-panels-view .tiles-scroller) { overflow-anchor: none; }
  :global(.tile-panels-view .tiles-scroller.banded) { overflow-y: scroll; }
  .tile-group { position: absolute; inset: 0; }

  /* An open folder's tile is its panel's tab (spec §9.3): like the outline, its
     selection and focus chrome stay open on the panel's side (square corners,
     no selected underline, no focus edge), so a selected parent runs into its
     panel instead of reading as a box closed off on top of it. These outrank
     TileSurface's selected edge and FileList's focus ring. */
  :global(.tile-panels-view .tile-row > .tile-item.tab-below) { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  :global(.tile-panels-view .tile-row > .tile-item.tab-above) { border-top-left-radius: 0; border-top-right-radius: 0; }
  :global(.file-list .tile-panels-view .tile-row > .tile-item.tab-below:is(.selected, :focus-visible)) { border-bottom-color: transparent; }
  /* The selected tint fades out toward the panel rather than stopping in a line. */
  :global(.tile-panels-view .tile-row > .tile-item.tab-below.selected:not(:hover, .drop-target)) {
    background: linear-gradient(to bottom, color-mix(in srgb, var(--accent) 8%, transparent) 50%, transparent) border-box;
  }
  :global(.tile-panels-view .tile-row > .tile-item.tab-above.selected:not(:hover, .drop-target)) {
    background: linear-gradient(to top, color-mix(in srgb, var(--accent) 8%, transparent) 50%, transparent) border-box;
  }
  /* The ring is the 1px border plus a 1px inset shadow: FileList's 2px inset outline, less one side. */
  :global(.file-list .tile-panels-view .tile-row > .tile-item.tab-below:focus-visible:not(.drop-target)) {
    outline: none;
    border-color: var(--focus-stroke-outer) var(--focus-stroke-outer) transparent;
    box-shadow: inset 1px 1px 0 var(--focus-stroke-outer), inset -1px 0 0 var(--focus-stroke-outer);
  }
  :global(.file-list .tile-panels-view .tile-row > .tile-item.tab-above:focus-visible:not(.drop-target)) {
    outline: none;
    border-color: transparent var(--focus-stroke-outer) var(--focus-stroke-outer);
    box-shadow: inset 1px 0 0 var(--focus-stroke-outer), inset -1px 0 0 var(--focus-stroke-outer);
  }
  .tile-row { position: absolute; left: 0; right: 0; }

  /* The Tiles caret (spec §9.3): a small round badge on the icon's corner,
     pointing right when closed and toward its panel when open. It is the
     tile's child, not the icon's, so the shared TileVisual (and with it classic
     Tiles) carries no hook for it: the icon is centred, and its top is the
     tile's top padding (--tile-caret-top puts the badge 3px below its bottom). */
  .tile-caret {
    position: absolute;
    left: calc(50% + var(--tile-icon-size, 64px) / 2 - 14px);
    top: var(--tile-caret-top);
    z-index: 1;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--control-stroke);
    background: var(--background-solid);
    color: var(--text-secondary);
    box-shadow: 0 1px 2px var(--shadow-subtle);
    cursor: pointer;
  }
  .tile-caret:hover { border-color: var(--accent); color: var(--text-primary); }
  .tile-caret.open { border-color: var(--accent); color: var(--accent-text); }
  /* Details' chevron (stroke 1.3, round caps) as a mask, as in List. */
  .tile-caret::before {
    content: "";
    width: 11px;
    height: 11px;
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M3.5 2 6.5 5 3.5 8' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 11px 11px no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M3.5 2 6.5 5 3.5 8' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 11px 11px no-repeat;
  }
  .tile-caret.down::before { transform: rotate(90deg); }
  .tile-caret.up::before { transform: rotate(-90deg); }
</style>
