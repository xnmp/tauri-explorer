<!--
  TilesView - Grid view with thumbnails.

  DOM-virtualized by ROW (#128): entries are chunked row-major into rows of
  `tileColumns` (derived from container width, matching CSS auto-fill), and each
  row is one fixed-height VirtualList item, so only the visible rows — and their
  thumbnail IntersectionObservers — live in the DOM. Tiles reserve a fixed
  two-line name height so every row is the same height.
  Issue: tauri-explorer-9djf.5, #128
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { useRowGridView } from "$lib/composables/use-row-grid-view.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { autoFillColumns } from "$lib/domain/virtual-layout";
  import { tileLayout, TILE_GRID_PAD_X } from "$lib/domain/tile-layout";
  import { createScrollJankMonitor } from "$lib/domain/scroll-jank-monitor";
  import { logFrontendDiagnostic } from "$lib/api/frontend-log";

  import { folderTileSize } from "$lib/state/folder-tile-size";
  import EntryName from "./EntryName.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import TileSurface from "./TileSurface.svelte";
  import TileVisual from "./TileVisual.svelte";
  import InlineNewFolder, { isNewFolderSentinel } from "./InlineNewFolder.svelte";
  import EntryCell from "./EntryCell.svelte";
  import VirtualList from "./VirtualList.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    contentWidth: number;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
    /** Scroll the given displayEntries index into view (bound by FileList). */
    scrollToIndex?: (index: number) => void;
    containsIndex?: (index: number) => boolean;
    fallbackTabStop: boolean;
    onviewportscroll?: () => void;
    onlayoutchange?: () => void;
  }

  let { explorer, contentWidth, onitemclick, onitemdblclick, scrollToIndex = $bindable(), containsIndex = $bindable(), fallbackTabStop, onviewportscroll, onlayoutchange }: Props = $props();

  const effectiveThumbnailSize = $derived(folderTileSize(explorer.currentPath));
  // Sizes, spacing and the fixed row height shared with every tile grid.
  const layout = $derived(tileLayout(effectiveThumbnailSize));

  // Column count matching CSS repeat(auto-fill, minmax(gridMinWidth, 1fr)),
  // less the viewport's horizontal padding.
  const tileColumns = $derived(
    autoFillColumns(contentWidth - TILE_GRID_PAD_X, layout.gridMinWidth, layout.gap)
  );

  // Shared row-grid wiring (interactions, pointer drag, sentinel splice,
  // row chunking, scrollToIndex mapping) — see useRowGridView.
  const grid = useRowGridView({
    getExplorer: () => explorer,
    refreshPanes: () => windowTabsManager.refreshAllPanes(),
    getColumns: () => tileColumns,
  });
  const { interactions, pointerDrag } = grid;
  scrollToIndex = grid.scrollToIndex;
  containsIndex = grid.containsIndex;

  // Videos whose thumbnail generation failed (e.g. no ffmpeg) fall back to the
  // plain icon. Keyed by path; reset on navigation.
  let unavailableThumbs = $state(new Set<string>());
  $effect(() => {
    // Reset when the directory changes.
    explorer.currentPath;
    unavailableThumbs = new Set<string>();
  });
  function markUnavailable(path: string) {
    if (unavailableThumbs.has(path)) return;
    const next = new Set(unavailableThumbs);
    next.add(path);
    unavailableThumbs = next;
  }

  // Scroll-jank diagnostics (#593): sample rAF gaps while the tiles scroller
  // is scrolling and report janky windows into the native app log, alongside
  // the backend's `thumb:` timing lines.
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!rootEl) return;
    const monitor = createScrollJankMonitor();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    function onScroll() {
      monitor.start();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const report = monitor.stop();
        if (report && report.longFrames > 0) {
          logFrontendDiagnostic("tiles-scroll-jank", {
            entries: explorer.displayEntries.length,
            thumbnailSize: effectiveThumbnailSize,
            frames: report.frames,
            longFrames: report.longFrames,
            worstFrameMs: Math.round(report.worstFrameMs),
            durationMs: Math.round(report.durationMs),
          });
        }
      }, 400);
    }

    // Scroll doesn't bubble, but capture-phase listeners on an ancestor still
    // see descendant scrolls — the VirtualList scroller lives inside rootEl.
    rootEl.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      rootEl?.removeEventListener("scroll", onScroll, { capture: true });
      clearTimeout(idleTimer);
      monitor.stop();
    };
  });
</script>

<TileSurface class="tiles-view" fill {layout} bind:element={rootEl} data-columns={tileColumns}>
  <VirtualList
    class="tiles-scroller file-rows"
    role="grid" aria-label="Files" aria-multiselectable={true}
    aria-rowcount={grid.rows.length} aria-colcount={tileColumns}
    tabindex={fallbackTabStop ? 0 : -1}
    bind:containsIndex={grid.rowContainsIndex}
    items={grid.rows}
    itemHeight={layout.rowHeight}
    itemOverflow="visible"
    viewportPadding="8px"
    getKey={(row) => row.startIndex}
    {onviewportscroll}
    {onlayoutchange}
    bind:scrollToIndex={grid.rowScrollToIndex}
  >
    {#snippet children(row, rowIndex)}
      <div role="row" aria-rowindex={rowIndex + 1} class="tile-row" style="grid-template-columns: repeat({tileColumns}, minmax(0, 1fr)); gap: var(--tile-gap);">
        {#each row.items as entry, col (entry.path)}
          {#if isNewFolderSentinel(entry)}
            <div role="gridcell"><InlineNewFolder {explorer} variant="tiles" /></div>
          {:else}
          <EntryCell column={col + 1} class="tile-item" index={row.startIndex + col - grid.sentinelOffset} {entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}>
            <TileVisual {entry} {layout} videoUnavailable={unavailableThumbs.has(entry.path)} onvideounavailable={() => markUnavailable(entry.path)}>
              {#snippet name()}<EntryName {entry} {explorer} variant="tiles" />{/snippet}
            </TileVisual>
            <GitStatusBadge entryName={entry.name} />
          </EntryCell>
          {/if}
        {/each}
      </div>
    {/snippet}
  </VirtualList>
</TileSurface>

<!-- Tile chrome lives in TileSurface; the icon block and name in TileVisual. -->
