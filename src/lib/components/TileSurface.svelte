<!--
  TileSurface - The root of a tile grid: publishes a TileLayout as the tile
  CSS variables and owns the tile chrome (padding, hover, selected underline,
  ghosted/cut/drop states, icon scaling) for every `.tile-item` inside it.
  TilesView (virtualized) and FileTiles (the plugin SDK's tiles) both render
  through it so their tiles cannot drift apart.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import type { TileLayout } from "$lib/domain/tile-layout";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    layout: TileLayout;
    /** Fill a flex-column parent (the pane's virtualized view). */
    fill?: boolean;
    element?: HTMLDivElement;
    children: Snippet;
  }

  let { layout, fill = false, element = $bindable(), class: className = "", children, ...rest }: Props = $props();
</script>

<div
  {...rest}
  class="tile-surface {className}"
  class:fill
  bind:this={element}
  style:--tile-icon-size="{layout.displaySize}px"
  style:--tile-min-col="{layout.gridMinWidth}px"
  style:--tile-icon-scale={layout.iconScale}
  style:--tile-gap="{layout.gap}px"
  style:--tile-padding={layout.padding}
  style:--tile-name-height="{layout.nameHeight}px"
>
  {@render children()}
</div>

<style>
  .tile-surface.fill {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .tile-surface :global(.tile-row) {
    display: grid;
    align-content: start;
  }

  .tile-surface :global(.tile-item) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: var(--tile-padding, 12px 8px 10px);
    background: transparent;
    border: 1px solid transparent;
    border-bottom-width: var(--selection-indicator-width);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: center;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    min-width: 0;
    contain: layout style;
    position: relative;
  }

  /* Reserve a fixed two-line name area so every tile — and therefore every
     virtualized row — is exactly the layout's row height tall. */
  .tile-surface :global(.tile-item [data-drag-name]) {
    width: 100%;
    min-height: var(--tile-name-height, 37px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }

  .tile-surface :global(.tile-item:focus) {
    outline: none;
  }

  .tile-surface :global(.tile-item:hover) {
    background: var(--subtle-fill-secondary);
  }

  .tile-surface :global(.tile-item:active) {
    transform: scale(0.97);
  }

  .tile-surface :global(.tile-item.selected) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-bottom-color: var(--accent);
    border-radius: var(--radius-md) var(--radius-md) 2px 2px;
  }

  .tile-surface :global(.tile-item.selected:hover) {
    background: var(--subtle-fill-tertiary);
  }

  /* Ghosted entries (hidden, empty folder, cut) dim their icon and quiet
     their label to --text-secondary. Dimming the whole row pulled the name
     below WCAG AA contrast in every theme (#785); Windows Explorer ghosts
     the icon for the same states. */
  .tile-surface :global(.tile-item:is(.hidden-entry, .empty-folder, .cut)) {
    color: var(--text-secondary);
  }

  .tile-surface :global(.tile-item:is(.hidden-entry, .empty-folder) [data-drag-icon]) {
    opacity: 0.55;
  }

  .tile-surface :global(.tile-item:is(.hidden-entry, .empty-folder):is(:hover, .selected) [data-drag-icon]) {
    opacity: 0.8;
  }

  .tile-surface :global(.tile-item.cut [data-drag-icon]) {
    opacity: 0.5;
  }

  .tile-surface :global(.tile-item.in-clipboard:not(.cut)) {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }

  .tile-surface :global(.tile-item.drop-target) {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .tile-surface :global(.tile-item.drop-target.copy-drop) {
    background: color-mix(in srgb, var(--system-success) 15%, transparent);
    box-shadow: inset 0 0 0 1px var(--system-success);
  }

  .tile-surface :global(.tile-icon) {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tile-icon-size, 64px);
    height: var(--tile-icon-size, 64px);
    flex-shrink: 0;
  }

  /* Scale file icons (64px SVGs) to fill the tile at medium/large sizes.
     Uses GPU-composited transform instead of re-rasterizing SVGs.
     Only targets direct children (FileIcon output), not nested thumbnail SVGs. */
  .tile-surface :global(.tile-icon > svg),
  .tile-surface :global(.tile-icon > .icon-cat),
  .tile-surface :global(.tile-icon > .nf-icon-badge),
  /* FolderThumbnail's imageless fallback nests the same FileIcon one level
     deeper — scale it identically to a bare icon. The preview-mode folder
     glyph (.folder-layer) is already sized to the tile, so it must be
     EXCLUDED here or it gets scaled twice and dwarfs the plain icon (#148). */
  .tile-surface :global(.tile-icon > .folder-thumb > svg:not(.folder-layer)),
  .tile-surface :global(.tile-icon > .folder-thumb > .icon-cat),
  .tile-surface :global(.tile-icon > .folder-thumb > .nf-icon-badge) {
    transform: scale(var(--tile-icon-scale, 1));
  }

  /* While renaming, the floating rename box must overflow the tile:
     contain:paint clips, so lift it on the renaming tile only, and raise it
     above its siblings. */
  .tile-surface :global(.tile-item:has(.tile-rename)) {
    contain: layout style;
    z-index: 10;
  }

  /* While renaming, hide the selection accent underline — it otherwise shows as
     a stray colored line beneath the floating rename box. */
  .tile-surface :global(.tile-item.selected:has(.tile-rename)) {
    border-bottom-color: transparent;
  }

  /* Git status indicator — positioned top-right of tile */
  .tile-surface :global(.tile-item .git-indicator) {
    position: absolute;
    top: 4px;
    right: 6px;
  }

  /* Symlink badge — positioned top-left of tile (git indicator owns top-right) */
  .tile-surface :global(.tile-item .symlink-badge) {
    position: absolute;
    top: 4px;
    left: 6px;
  }
</style>
