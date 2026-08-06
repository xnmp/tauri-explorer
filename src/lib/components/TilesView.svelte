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
  import { getFileIconColor, isImageFile, isVideoFile } from "$lib/domain/file-types";
  import { createScrollJankMonitor } from "$lib/domain/scroll-jank-monitor";
  import { logFrontendDiagnostic } from "$lib/api/frontend-log";

  import { settingsStore, THUMBNAIL_SIZE_CONFIG } from "$lib/state/settings.svelte";
  import { folderViewsStore } from "$lib/state/folder-views.svelte";
  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import ThumbnailImage from "./ThumbnailImage.svelte";
  import FolderThumbnail from "./FolderThumbnail.svelte";
  import InlineNewFolder, { isNewFolderSentinel } from "./InlineNewFolder.svelte";
  import ItemButton from "./ItemButton.svelte";
  import VirtualList from "./VirtualList.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    contentWidth: number;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
    /** Scroll the given displayEntries index into view (bound by FileList). */
    scrollToIndex?: (index: number) => void;
  }

  let { explorer, contentWidth, onitemclick, onitemdblclick, scrollToIndex = $bindable() }: Props = $props();

  // Reserved fixed name height: two lines at line-height 1.4 * 13px font.
  const NAME_HEIGHT = 37;
  // Viewport horizontal padding (8px each side) reserved out of the grid width.
  const VIEWPORT_PAD_X = 16;

  const effectiveThumbnailSize = $derived(
    folderViewsStore.getThumbnailSize(explorer.currentPath, settingsStore.thumbnailSize)
  );
  const tileConfig = $derived(THUMBNAIL_SIZE_CONFIG[effectiveThumbnailSize]);
  const isSmall = $derived(effectiveThumbnailSize === "small");
  const tileGap = $derived(isSmall ? 2 : 6);
  // padding-top + padding-bottom of a tile (var(--tile-padding))
  const tilePadV = $derived(isSmall ? 12 : 22);
  // Fixed row height: tile paddings + icon + icon→name gap (4) + reserved name
  // + selection border (2) + the inter-row grid gap.
  const tileRowHeight = $derived(tilePadV + tileConfig.displaySize + 4 + NAME_HEIGHT + 2 + tileGap);

  // Column count matching CSS repeat(auto-fill, minmax(gridMinWidth, 1fr)).
  const tileColumns = $derived(
    autoFillColumns(contentWidth - VIEWPORT_PAD_X, tileConfig.gridMinWidth, tileGap)
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

  // Folder previews only render at large/xlarge tile sizes (smaller tiles
  // keep the plain folder icon, like Windows Explorer).
  const showFolderThumbnails = $derived(
    effectiveThumbnailSize === "large" || effectiveThumbnailSize === "xlarge"
  );

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

<div
  class="tiles-view"
  bind:this={rootEl}
  data-columns={tileColumns}
  style:--tile-icon-size="{tileConfig.displaySize}px"
  style:--tile-min-col="{tileConfig.gridMinWidth}px"
  style:--tile-icon-scale={tileConfig.displaySize / 64}
  style:--tile-gap="{tileGap}px"
  style:--tile-padding={isSmall ? "6px 4px 6px" : "12px 8px 10px"}
  style:--tile-name-height="{NAME_HEIGHT}px"
>
  <VirtualList
    class="tiles-scroller file-rows"
    items={grid.rows}
    itemHeight={tileRowHeight}
    itemOverflow="visible"
    viewportPadding="8px"
    getKey={(row) => row.startIndex}
    bind:scrollToIndex={grid.rowScrollToIndex}
  >
    {#snippet children(row)}
      <div class="tile-row" style="grid-template-columns: repeat({tileColumns}, minmax(0, 1fr)); gap: var(--tile-gap);">
        {#each row.items as entry, col (entry.path)}
          {#if isNewFolderSentinel(entry)}
            <InlineNewFolder {explorer} variant="tiles" />
          {:else}
          {@const iconColor = getFileIconColor(entry)}
          <ItemButton class="tile-item" index={row.startIndex + col - grid.sentinelOffset} {entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}>
            <div class="tile-icon" style:color={iconColor} data-drag-icon>
              {#if isImageFile(entry)}
                <ThumbnailImage path={entry.path} size={tileConfig.displaySize} genSize={tileConfig.genSize} quality={tileConfig.quality} fallbackColor={iconColor} />
              {:else if isVideoFile(entry) && !unavailableThumbs.has(entry.path)}
                <ThumbnailImage kind="video" path={entry.path} size={tileConfig.displaySize} genSize={tileConfig.genSize} quality={tileConfig.quality} fallbackColor={iconColor} onunavailable={() => markUnavailable(entry.path)} />
              {:else if entry.kind === "directory" && showFolderThumbnails}
                <FolderThumbnail path={entry.path} modified={entry.modified} size={tileConfig.displaySize} genSize={tileConfig.genSize} quality={tileConfig.quality}>
                  <FileIcon {entry} size="large" />
                </FolderThumbnail>
              {:else}
                <FileIcon {entry} size="large" />
              {/if}
            </div>
            <span data-drag-name><EntryName {entry} {explorer} variant="tiles" /></span>
            <GitStatusBadge entryName={entry.name} />
          </ItemButton>
          {/if}
        {/each}
      </div>
    {/snippet}
  </VirtualList>
</div>

<style>
  .tiles-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .tiles-view :global(.tile-row) {
    display: grid;
    align-content: start;
  }

  .tiles-view :global(.tile-item) {
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
     virtualized row — is exactly `tileRowHeight` tall. */
  .tiles-view :global(.tile-item [data-drag-name]) {
    width: 100%;
    min-height: var(--tile-name-height, 37px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }

  .tiles-view :global(.tile-item:focus) {
    outline: none;
  }

  .tiles-view :global(.tile-item:hover) {
    background: var(--subtle-fill-secondary);
    transition: background 120ms ease;
  }

  .tiles-view :global(.tile-item:active) {
    transform: scale(0.97);
  }

  .tiles-view :global(.tile-item.selected) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-color: transparent;
    border-bottom-color: var(--accent);
    border-radius: var(--radius-md) var(--radius-md) 2px 2px;
  }

  .tiles-view :global(.tile-item.selected:hover) {
    background: var(--subtle-fill-tertiary);
  }

  .tiles-view :global(.tile-item.hidden-entry) {
    opacity: 0.55;
  }

  .tiles-view :global(.tile-item.empty-folder) {
    opacity: 0.55;
  }

  .tiles-view :global(.tile-item.empty-folder:hover),
  .tiles-view :global(.tile-item.empty-folder.selected) {
    opacity: 0.8;
  }

  .tiles-view :global(.tile-item.cut) {
    opacity: 0.5;
  }

  .tiles-view :global(.tile-item.in-clipboard:not(.cut)) {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }

  .tiles-view :global(.tile-item.drop-target) {
    background: rgba(0, 120, 212, 0.15);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .tiles-view :global(.tile-item.drop-target.copy-drop) {
    background: rgba(16, 185, 129, 0.15);
    box-shadow: inset 0 0 0 1px #10b981;
  }

  .tiles-view :global(.tile-icon) {
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
  .tiles-view :global(.tile-icon > svg),
  .tiles-view :global(.tile-icon > .icon-cat),
  .tiles-view :global(.tile-icon > .nf-icon-badge),
  /* FolderThumbnail's imageless fallback nests the same FileIcon one level
     deeper — scale it identically to a bare icon. The preview-mode folder
     glyph (.folder-layer) is already sized to the tile, so it must be
     EXCLUDED here or it gets scaled twice and dwarfs the plain icon (#148). */
  .tiles-view :global(.tile-icon > .folder-thumb > svg:not(.folder-layer)),
  .tiles-view :global(.tile-icon > .folder-thumb > .icon-cat),
  .tiles-view :global(.tile-icon > .folder-thumb > .nf-icon-badge) {
    transform: scale(var(--tile-icon-scale, 1));
  }

  /* Name and rename styles are handled by EntryName component */

  /* While renaming, the floating rename box must overflow the tile:
     contain:paint clips, so lift it on the renaming tile only, and raise it
     above its siblings. */
  .tiles-view :global(.tile-item:has(.tile-rename)) {
    contain: layout style;
    z-index: 10;
  }

  /* While renaming, hide the selection accent underline — it otherwise shows as
     a stray colored line beneath the floating rename box. */
  .tiles-view :global(.tile-item.selected:has(.tile-rename)) {
    border-bottom-color: transparent;
  }

  /* Git status indicator — positioned top-right of tile */
  .tiles-view :global(.tile-item .git-indicator) {
    position: absolute;
    top: 4px;
    right: 6px;
  }

  /* Symlink badge — positioned top-left of tile (git indicator owns top-right) */
  .tiles-view :global(.tile-item .symlink-badge) {
    position: absolute;
    top: 4px;
    left: 6px;
  }
</style>
