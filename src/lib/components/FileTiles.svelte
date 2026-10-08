<!--
  FileTiles - The Tiles view's tiles for plugin-owned surfaces (SDK module
  `ui/file-tiles`). The plugin supplies the entries and selection and handles
  every interaction through callbacks; nothing here reads or changes pane
  state. Tiles render through TileSurface and TileVisual, the same chrome,
  thumbnails, names and size setting as the built-in Tiles view (the global
  setting, or the `size` a plugin passes from `pane.tileSize`).

  NOT virtualized: every tile is in the DOM. It serves plugin sections of
  modest size; a whole-directory listing belongs in TilesView.
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { autoFillColumns, chunkIntoRows } from "$lib/domain/virtual-layout";
  import { gridFocusStep, isThumbnailSize, tileLayout, TILE_GRID_PAD_X, type TileSizePreset } from "$lib/domain/tile-layout";
  import { settingsStore } from "$lib/state/settings.svelte";
  import TileSurface from "./TileSurface.svelte";
  import TileVisual from "./TileVisual.svelte";

  interface Props {
    entries: readonly FileEntry[];
    /** Selected entry paths. Pass a new Set (or a reactive one) to update
     *  it; mutating a plain Set in place does not re-render. */
    selected: ReadonlySet<string>;
    onselect: (entry: FileEntry, event: MouseEvent) => void;
    /** Double-click or Enter. */
    onopen: (entry: FileEntry) => void;
    onmenu: (entry: FileEntry, event: MouseEvent) => void;
    /** The grid's accessible name. */
    label?: string;
    /** Tile size preset (capability "tileSize"); a file view passes
     *  `pane.tileSize?.preset` to match its folder's size. Omitted or
     *  unknown, the global tile-size setting applies. */
    size?: TileSizePreset;
  }

  let { entries, selected, onselect, onopen, onmenu, label = "Files", size }: Props = $props();

  const layout = $derived(tileLayout(isThumbnailSize(size) ? size : settingsStore.thumbnailSize));
  let width = $state(0);
  // Same column math as TilesView, against this component's own width (less
  // the grid's 8px side padding). The width comes from a zero-height probe:
  // observing the grid itself would re-notify when new columns change its
  // height, a ResizeObserver loop.
  const columns = $derived(autoFillColumns(width - TILE_GRID_PAD_X, layout.gridMinWidth, layout.gap));
  const rows = $derived(chunkIntoRows(entries, columns));

  // Roving tab stop: the last focused tile while it is still listed, else the
  // first. One Tab enters the grid; arrows move within it.
  let focusedPath = $state<string | null>(null);
  const tabStop = $derived(
    focusedPath !== null && entries.some((entry) => entry.path === focusedPath) ? focusedPath : (entries[0]?.path ?? null),
  );

  // Videos whose thumbnail failed (e.g. no ffmpeg) keep their plain icon.
  let unavailable = $state<ReadonlySet<string>>(new Set());
  function markUnavailable(path: string): void {
    if (!unavailable.has(path)) unavailable = new Set([...unavailable, path]);
  }

  let gridEl: HTMLDivElement | undefined = $state();
  function onkeydown(event: KeyboardEvent, entry: FileEntry, index: number): void {
    if (event.key === "Enter" && !event.repeat) {
      event.preventDefault();
      onopen(entry);
      return;
    }
    const next = gridFocusStep(index, entries.length, columns, event.key);
    if (next === null) return;
    event.preventDefault();
    const path = entries[next].path;
    focusedPath = path;
    gridEl?.querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(path)}"]`)?.focus();
  }
</script>

<TileSurface class="file-tiles" {layout}>
  <div class="width-probe" aria-hidden="true" bind:clientWidth={width}></div>
  <div bind:this={gridEl} class="file-tiles-grid" role="grid" aria-label={label} aria-multiselectable={true}
    aria-rowcount={rows.length} aria-colcount={columns}>
    {#each rows as row, rowIndex (row.startIndex)}
      <div role="row" aria-rowindex={rowIndex + 1} class="tile-row" style="grid-template-columns: repeat({columns}, minmax(0, 1fr)); gap: var(--tile-gap);">
        {#each row.items as entry, col (entry.path)}
          {@const isSelected = selected.has(entry.path)}
          <div role="gridcell" class="tile-item" class:selected={isSelected} aria-selected={isSelected} aria-colindex={col + 1}
            tabindex={entry.path === tabStop ? 0 : -1} data-entry-path={entry.path}
            onfocus={() => (focusedPath = entry.path)}
            onclick={(event) => onselect(entry, event)}
            ondblclick={() => onopen(entry)}
            oncontextmenu={(event) => { event.preventDefault(); onmenu(entry, event); }}
            onkeydown={(event) => onkeydown(event, entry, row.startIndex + col)}>
            <TileVisual {entry} {layout} videoUnavailable={unavailable.has(entry.path)} onvideounavailable={() => markUnavailable(entry.path)} />
          </div>
        {/each}
      </div>
    {/each}
  </div>
</TileSurface>

<style>
  .width-probe {
    height: 0;
  }

  .file-tiles-grid {
    display: flex;
    flex-direction: column;
    gap: var(--tile-gap);
    /* The Tiles view's viewport padding. */
    padding: 8px;
  }

  /* Mirrors the pane's file-list focus ring: tiles put the selected
     indicator on their bottom edge. The role qualifier outranks
     TileSurface's `.tile-item:focus { outline: none }` regardless of
     stylesheet order. */
  .file-tiles-grid :global([role="gridcell"].tile-item:focus-visible) {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
    border-bottom-color: var(--focus-stroke-outer);
  }
</style>
