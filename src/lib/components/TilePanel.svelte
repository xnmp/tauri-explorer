<!--
  An open folder's panel in a Tiles band (#1241, spec §9): its tile grid in
  a scroll area with the List card's fade mask and "+N more", the resize grip
  on the far edge and, for a stacked panel, the label tab. The whole panel is
  the folder's drop and context-menu surface. Geometry (box) and policies are
  pure (tile-panels.ts); scroll offsets, the grip preview and the mounted
  window live in useTilePanels; the view renders each tile.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { TileLayout } from "$lib/domain/tile-layout";
  import { LIST_CARD_FADE } from "$lib/domain/list-cards";
  import {
    PANEL_PAD_X, PANEL_PAD_NEAR, panelFades, panelMoreCount, panelPadTop,
    type PanelBox, type TilePanelSpec,
  } from "$lib/domain/tile-panels";
  import type { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import { createSurfaceDropFeedback, surfaceDropPath } from "$lib/composables/surface-drop-feedback";
  import FileIcon from "./FileIcon.svelte";
  import TilePanelGrip from "./TilePanelGrip.svelte";
  import TileSurface from "./TileSurface.svelte";

  interface Props {
    box: PanelBox;
    spec: TilePanelSpec;
    folder: FileEntry;
    /** The pane's visible entries (spec.entries index into them). */
    entries: readonly FileEntry[];
    /** The grid's tile layout: panel tiles are the grid's own size. */
    layout: TileLayout;
    /** One tile row (PanelTileLayout.rowHeight). */
    rowHeight: number;
    /** The band's height (the grip's value) and the grip's range. */
    bandHeight: number;
    gripBounds: { min: number; max: number };
    /** Content offsets to mount (window, overscan and a renaming entry). */
    offsets: readonly number[];
    scrollTop: number;
    dragging: boolean;
    interactions: ReturnType<typeof useItemInteractions>;
    onscrolltop: (top: number) => void;
    ongripstart: (pointer: number, clientY: number) => void;
    ongripkey: (key: string) => boolean;
    onclose: () => void;
    onlabel: () => void;
    tile: Snippet<[FileEntry, number]>;
  }
  let {
    box, spec, folder, entries, layout, rowHeight, bandHeight, gripBounds, offsets, scrollTop, dragging,
    interactions, onscrolltop, ongripstart, ongripkey, onclose, onlabel, tile,
  }: Props = $props();

  const fades = $derived(panelFades(spec.contentHeight, box.height, scrollTop));
  const more = $derived(panelMoreCount(spec, box.height, rowHeight, scrollTop));
  const padTop = $derived(panelPadTop(box.side));
  // Mounted rows: plain objects carrying their entries, so a rename blur can
  // still read its entry after a commit has replaced the rows.
  const rows = $derived.by(() => {
    const byRow = new Map<number, { offset: number; index: number; entry: FileEntry }[]>();
    for (const offset of offsets) {
      const index = spec.entries[offset];
      const entry = entries[index];
      if (!entry) continue;
      const row = Math.floor(offset / spec.cols);
      byRow.set(row, [...(byRow.get(row) ?? []), { offset, index, entry }]);
    }
    return [...byRow].map(([row, items]) => ({ row, items }));
  });

  let scroller = $state<HTMLDivElement | undefined>();
  // Apply programmatic offsets (keyboard reveal, remount). Native scrolling
  // reports back through onscroll, so this never fights the user.
  $effect(() => {
    const top = scrollTop;
    if (scroller && Math.abs(scroller.scrollTop - top) > 0.5) scroller.scrollTop = top;
  });

  // The panel's own surface (not a tile) targets its folder; its tiles
  // are their own targets (or none), so reaching one retires the surface's
  // feedback (no leave fires for it: the tile is inside).
  const onSurface = (event: Event) => surfaceDropPath(event.target, folder.path) !== null;
  const surfaceDrop = createSurfaceDropFeedback(() => interactions, event => onSurface(event) ? folder : null);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- a pointer drop and context-menu surface spanning the label, scroll area (the rowgroup) and grip; the folder's own tile is its keyboard path. -->
<div class="tile-panel peek-drop-target" data-path={folder.path} data-panel-owner={folder.path}
  class:above={box.side === "above"} class:stacked={box.side === "stacked"}
  class:drop-target={interactions.isDropTarget(folder.path)}
  style:left="{box.x0}px" style:top="{box.top}px" style:width="{box.width}px" style:height="{box.height}px"
  style:opacity={box.opacity < 1 ? box.opacity : undefined}
  ondragenter={surfaceDrop.over} ondragover={surfaceDrop.over} ondragleave={surfaceDrop.leave} ondrop={surfaceDrop.drop}
  oncontextmenu={(event) => { if (onSurface(event)) interactions.handleContextMenu(event, folder); }}>
  {#if box.label}
    <div class="tile-panel-label" role="row" style:left="{box.label.x0 - box.x0}px" style:width="{box.label.width}px" style:height="{box.labelHeight}px">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -- a pointer shortcut to the parent; keyboard users reach it with the arrows. -->
      <div class="tile-panel-label-cell" role="gridcell" onclick={onlabel}>
        <span class="tile-panel-label-icon"><FileIcon entry={folder} size="small" /></span>
        <b>{folder.name}</b>
        <span class="tile-panel-label-count">· {spec.entries.length} {spec.entries.length === 1 ? "item" : "items"}</span>
        <button class="tile-panel-close" type="button" tabindex="-1" aria-label={`Close ${folder.name}`}
          onmousedown={(event) => event.preventDefault()}
          onclick={(event) => { event.stopPropagation(); onclose(); }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
        </button>
      </div>
    </div>
  {/if}
  <!-- The scroll area is the panel's rowgroup: tabindex -1 keeps Chrome from
       making the scroller a Tab stop, and a focusable element inside a grid
       needs a role of its own (the label and grip are rows of the grid). -->
  <TileSurface {layout} class="tile-panel-scroll" data-marquee-clip tabindex={-1}
    role="rowgroup" aria-label={`${folder.name} contents`}
    style="--fade-top: {fades.top ? LIST_CARD_FADE : 0}px; --fade-bottom: {fades.bottom ? LIST_CARD_FADE : 0}px"
    bind:element={scroller}
    onscroll={() => { if (scroller) onscrolltop(scroller.scrollTop); }}>
    <div class="tile-panel-content" style:height="{spec.contentHeight}px">
      {#if spec.message !== null && spec.entries.length === 0}
        <div class="tile-panel-row tile-panel-state" role="row" style:top="{padTop}px" style:left="{PANEL_PAD_NEAR}px" style:width="{Math.max(0, box.width - PANEL_PAD_X)}px" style:height="{rowHeight}px">
          <div role="gridcell"><span role="status">{spec.message}</span></div>
        </div>
      {:else}
        {#each rows as row (row.row)}
          <div class="tile-panel-row" role="row"
            style:top="{padTop + row.row * rowHeight}px" style:left="{PANEL_PAD_NEAR}px"
            style:width="{Math.max(0, box.width - PANEL_PAD_X)}px" style:height="{rowHeight}px"
            style:grid-template-columns="repeat({spec.cols}, {spec.track}px)">
            {#each row.items as item (item.entry.path)}
              <div class="tile-panel-slot" style:grid-column={(item.offset % spec.cols) + 1}>
                {@render tile(item.entry, item.index)}
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </TileSurface>
  {#if more > 0}<span class="tile-panel-more" aria-hidden="true">+{more} more</span>{/if}
  {#if spec.entries.length > 0}
    <TilePanelGrip name={folder.name} side={box.side} height={bandHeight} min={gripBounds.min} max={gripBounds.max}
      {rowHeight} {dragging} onstart={ongripstart} onkey={ongripkey} />
  {/if}
</div>

<style>
  .tile-panel {
    position: absolute;
    border-radius: 10px;
  }
  /* A drag over the panel's own surface tints it (its parent tile lights up too). */
  .tile-panel.drop-target :global(.tile-panel-scroll) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .tile-panel :global(.tile-panel-scroll) {
    position: absolute;
    inset: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overflow-anchor: none;
    scrollbar-width: thin;
    border-radius: 10px;
    mask-image: linear-gradient(to bottom, transparent, #000 var(--fade-top), #000 calc(100% - var(--fade-bottom)), transparent);
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 var(--fade-top), #000 calc(100% - var(--fade-bottom)), transparent);
  }
  .tile-panel-content { position: relative; }
  .tile-panel-row {
    position: absolute;
    display: grid;
    justify-content: center;
    align-items: start;
  }
  .tile-panel-slot { display: flex; min-width: 0; }
  .tile-panel-state {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .tile-panel-more {
    position: absolute;
    bottom: -7px;
    left: calc(50% + 30px);
    font-size: 10px;
    line-height: 14px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    z-index: 4;
  }
  .tile-panel.above .tile-panel-more { top: -7px; bottom: auto; }
  .tile-panel-label {
    position: absolute;
    bottom: 100%;
    overflow: hidden;
    z-index: 2;
  }
  .tile-panel-label-cell {
    height: 30px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px 0 14px;
    white-space: nowrap;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    user-select: none;
  }
  .tile-panel-label-icon { display: flex; flex: none; width: 16px; height: 16px; align-items: center; justify-content: center; }
  .tile-panel-label-cell b, .tile-panel-label-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tile-panel-label-cell b { font-weight: 600; }
  .tile-panel-label-count { color: var(--text-secondary); }
  .tile-panel-close {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    margin-left: auto;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .tile-panel-close:hover { color: var(--text-primary); background: var(--subtle-fill-tertiary); }

  /* Panel tiles are grid tiles: half the tile gap inside each side of a track. */
  .tile-panel :global(.tile-item.tile-panel-item) {
    flex: 1;
    margin: calc(var(--tile-gap) / 2);
  }
</style>
