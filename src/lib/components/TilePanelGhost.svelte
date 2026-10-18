<!--
  A closing Tiles panel's ghost (#1241, spec §9.5): its last visible content,
  captured as entries when it closed, collapsing with the motion frame. Ghost
  rule: inert and aria-hidden, with no identity classes (.tile-item,
  .entry-item, .peek-drop-target, .drop-target), data or ARIA attributes, so no
  live query (selection, marquee, drop targets, focus) can reach it. It exists
  only while its motion runs.
-->
<script lang="ts">
  import type { TileLayout } from "$lib/domain/tile-layout";
  import { PANEL_PAD_NEAR, PANEL_PAD_X, panelPadTop, type PanelBox } from "$lib/domain/tile-panels";
  import type { TileGhost } from "$lib/composables/use-tile-panels.svelte";
  import FileIcon from "./FileIcon.svelte";
  import TileVisual from "./TileVisual.svelte";

  interface Props {
    box: PanelBox;
    ghost: TileGhost;
    layout: TileLayout;
    rowHeight: number;
  }
  let { box, ghost, layout, rowHeight }: Props = $props();
  const padTop = $derived(panelPadTop(box.side));
  const rows = $derived(Array.from({ length: Math.ceil(ghost.entries.length / Math.max(1, ghost.cols)) }, (_, i) =>
    ({ row: ghost.firstRow + i, entries: ghost.entries.slice(i * ghost.cols, (i + 1) * ghost.cols) })));
</script>

<div class="tile-panel-ghost" inert aria-hidden="true"
  style:left="{box.x0}px" style:top="{box.top}px" style:width="{box.width}px" style:height="{box.height}px" style:opacity={box.opacity}
  style:--tile-icon-size="{layout.displaySize}px" style:--tile-icon-scale={layout.iconScale} style:--tile-name-height="{layout.nameHeight}px"
  style:--tile-padding={layout.padding} style:--tile-gap="{layout.gap}px">
  {#if box.label}
    <div class="ghost-label" style:left="{box.label.x0 - box.x0}px" style:width="{box.label.width}px" style:height="{box.labelHeight}px">
      <span class="ghost-label-icon"><FileIcon entry={ghost.folder} size="small" /></span>
      <b>{ghost.folder.name}</b>
      <span class="ghost-label-count">· {ghost.itemCount} {ghost.itemCount === 1 ? "item" : "items"}</span>
    </div>
  {/if}
  <div class="ghost-scroll">
    <div class="ghost-content" style:transform="translateY({-ghost.scrollTop}px)">
      {#if ghost.message !== null && ghost.entries.length === 0}
        <div class="ghost-row ghost-state" style:top="{padTop}px" style:left="{PANEL_PAD_NEAR}px" style:width="{Math.max(0, box.width - PANEL_PAD_X)}px" style:height="{rowHeight}px">{ghost.message}</div>
      {:else}
        {#each rows as row (row.row)}
          <div class="ghost-row" style:top="{padTop + row.row * rowHeight}px" style:left="{PANEL_PAD_NEAR}px"
            style:width="{Math.max(0, box.width - PANEL_PAD_X)}px" style:height="{rowHeight}px"
            style:grid-template-columns="repeat({ghost.cols}, {ghost.track}px)">
            {#each row.entries as entry (entry.path)}
              <div class="ghost-cell"><TileVisual {entry} {layout} /></div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .tile-panel-ghost { position: absolute; pointer-events: none; }
  .ghost-scroll { position: absolute; inset: 0; overflow: hidden; border-radius: 10px; }
  .ghost-content { position: relative; }
  .ghost-row { position: absolute; display: grid; justify-content: center; align-items: start; }
  .ghost-state { display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: 12px; }
  /* A panel tile's look (TileSurface's .tile-item chrome at rest), without its identity. */
  .ghost-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    margin: calc(var(--tile-gap) / 2);
    padding: var(--tile-padding);
    border: 1px solid transparent;
    border-bottom-width: var(--selection-indicator-width);
    font-size: 13px;
    color: var(--text-primary);
    text-align: center;
    min-width: 0;
  }
  .ghost-cell :global(.tile-icon) {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tile-icon-size);
    height: var(--tile-icon-size);
    flex-shrink: 0;
  }
  .ghost-cell :global(.tile-icon > svg), .ghost-cell :global(.tile-icon > .icon-cat), .ghost-cell :global(.tile-icon > .nf-icon-badge) {
    flex-shrink: 0;
    transform: scale(var(--tile-icon-scale, 1));
  }
  .ghost-cell :global([data-drag-name]) {
    width: 100%;
    min-height: var(--tile-name-height);
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }
  .ghost-label {
    position: absolute;
    bottom: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px 0 14px;
    overflow: hidden;
    white-space: nowrap;
    font-size: 13px;
    color: var(--text-primary);
  }
  .ghost-label-icon { display: flex; flex: none; width: 16px; height: 16px; align-items: center; justify-content: center; }
  .ghost-label b { font-weight: 600; }
  .ghost-label-count { color: var(--text-secondary); }
</style>
