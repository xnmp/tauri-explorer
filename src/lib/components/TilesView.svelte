<!--
  TilesView - Grid view with thumbnails and progressive rendering.
  Issue: tauri-explorer-9djf.5
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
  import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { useProgressiveRender } from "$lib/composables/use-progressive-render.svelte";
  import { getFileIconColor, isImageFile, isVideoFile } from "$lib/domain/file-types";

  import { usesPointerDrag } from "$lib/domain/platform";
  import { settingsStore, THUMBNAIL_SIZE_CONFIG } from "$lib/state/settings.svelte";
  import { folderViewsStore } from "$lib/state/folder-views.svelte";
  import EntryName from "./EntryName.svelte";
  import FileIcon from "./FileIcon.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";
  import ThumbnailImage from "./ThumbnailImage.svelte";
  import FolderThumbnail from "./FolderThumbnail.svelte";
  import InlineNewFolder from "./InlineNewFolder.svelte";
  import ItemButton from "./ItemButton.svelte";

  import type { FileEntry } from "$lib/domain/file";

  interface Props {
    explorer: ExplorerInstance;
    onitemclick: (entry: FileEntry, event: MouseEvent) => void;
    onitemdblclick: (entry: FileEntry) => void;
  }

  let { explorer, onitemclick, onitemdblclick }: Props = $props();


  // Shared item interactions (DnD, context menu with select-on-right-click)
  const interactions = useItemInteractions({
    getExplorer: () => explorer,
    refreshPanes: () => windowTabsManager.refreshAllPanes(),
    selectOnContextMenu: true,
  });

  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer: () => explorer, refreshPanes: () => windowTabsManager.refreshAllPanes() }) : null;

  const effectiveThumbnailSize = $derived(
    folderViewsStore.getThumbnailSize(explorer.currentPath, settingsStore.thumbnailSize)
  );
  const tileConfig = $derived(THUMBNAIL_SIZE_CONFIG[effectiveThumbnailSize]);

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

  // Progressive rendering to avoid UI freeze on large directories.
  // Only resets the render limit when entry count increases significantly
  // (e.g. navigating to a new directory), not on small changes like deletions.
  const TILE_CHUNK = 60;
  const progressive = useProgressiveRender(() => explorer.displayEntries.length, TILE_CHUNK);

  const visibleTileEntries = $derived(
    explorer.displayEntries.slice(0, progressive.limit)
  );

  // Scroll performance logging (dev only)
  let scrollFrameTimes: number[] = [];
  let scrollRafId: number | null = null;
  let lastScrollTime = 0;

  function handleScroll(): void {
    if (!import.meta.env.DEV) return;
    const now = performance.now();
    if (lastScrollTime > 0) {
      scrollFrameTimes.push(now - lastScrollTime);
    }
    lastScrollTime = now;

    if (scrollRafId) cancelAnimationFrame(scrollRafId);
    scrollRafId = requestAnimationFrame(() => {
      // After scroll settles, log metrics
      scrollRafId = requestAnimationFrame(() => {
        if (scrollFrameTimes.length > 2) {
          const avg = scrollFrameTimes.reduce((a, b) => a + b, 0) / scrollFrameTimes.length;
          const max = Math.max(...scrollFrameTimes);
          const jank = scrollFrameTimes.filter((t) => t > 33).length; // frames > 30fps
          console.debug(
            `[tiles-scroll] ${scrollFrameTimes.length} frames, avg=${avg.toFixed(1)}ms, max=${max.toFixed(1)}ms, jank=${jank} (>${(jank / scrollFrameTimes.length * 100).toFixed(0)}%), entries=${visibleTileEntries.length}`
          );
        }
        scrollFrameTimes = [];
        lastScrollTime = 0;
      });
    });
  }
</script>

<div class="tiles-view file-rows" onscroll={handleScroll} style:--tile-icon-size="{tileConfig.displaySize}px" style:--tile-min-col="{tileConfig.gridMinWidth}px" style:--tile-icon-scale={tileConfig.displaySize / 64} style:--tile-gap="{effectiveThumbnailSize === 'small' ? 2 : 6}px" style:--tile-padding="{effectiveThumbnailSize === 'small' ? '6px 4px 6px' : '12px 8px 10px'}">
  {#if explorer.isCreatingFolder}
    <InlineNewFolder {explorer} variant="tiles" />
  {/if}
  {#each visibleTileEntries as entry (entry.path)}
    {@const iconColor = getFileIconColor(entry)}
    <ItemButton class="tile-item" {entry} {explorer} {interactions} {pointerDrag} {onitemclick} {onitemdblclick}>
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
  {/each}
</div>

<style>
  .tiles-view {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--tile-min-col, 108px), 1fr));
    grid-auto-rows: min-content;
    align-content: start;
    gap: var(--tile-gap, 6px);
    padding: 8px;
    overflow-y: auto;
    flex: 1;
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
    height: fit-content;
    min-width: 0;
    contain: layout style paint;
    content-visibility: auto;
    position: relative;
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
     contain:paint and content-visibility:auto both clip, so lift them on
     the renaming tile only, and raise it above its siblings. */
  .tiles-view :global(.tile-item:has(.tile-rename)) {
    contain: layout style;
    content-visibility: visible;
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
