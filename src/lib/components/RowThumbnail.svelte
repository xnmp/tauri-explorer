<!--
  RowThumbnail - The 48px icon box of a Details or List row while the
  `rowThumbnails` setting is on (#1465). Images and videos show their
  thumbnail through the shared ThumbnailImage load/cache path; it requests
  only while this (virtualized, mounted) row is on screen and shows the file's
  icon while loading or when no thumbnail can be made. Other entries show
  their large icon scaled into the same box, so every row lines up.
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { getFileIconColor } from "$lib/domain/file-types";
  import { ROW_THUMBNAIL_GEN_SIZE, ROW_THUMBNAIL_QUALITY, ROW_THUMBNAIL_SIZE, rowThumbnailKind } from "$lib/domain/row-thumbnails";
  import FileIcon from "./FileIcon.svelte";
  import ThumbnailImage from "./ThumbnailImage.svelte";

  let { entry }: { entry: FileEntry } = $props();
  const kind = $derived(rowThumbnailKind(entry));
</script>

<span class="row-thumbnail" data-row-thumbnail={kind ?? "icon"} style:--row-thumbnail-size="{ROW_THUMBNAIL_SIZE}px" style:--row-icon-scale={ROW_THUMBNAIL_SIZE / 64}>
  {#if kind}
    <ThumbnailImage {kind} path={entry.path} size={ROW_THUMBNAIL_SIZE} genSize={ROW_THUMBNAIL_GEN_SIZE}
      quality={ROW_THUMBNAIL_QUALITY} fallbackColor={getFileIconColor(entry)}>
      {#snippet fallback()}<FileIcon {entry} size="large" />{/snippet}
    </ThumbnailImage>
  {:else}
    <span class="row-thumbnail-icon"><FileIcon {entry} size="large" /></span>
  {/if}
</span>

<style>
  .row-thumbnail {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--row-thumbnail-size);
    height: var(--row-thumbnail-size);
    flex-shrink: 0;
  }

  /* The large icon is 64px; scale it into the thumbnail box like ThumbnailImage's
     pack-icon fallback, without changing layout size. */
  .row-thumbnail-icon {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .row-thumbnail-icon :global(> *) {
    flex-shrink: 0;
    transform: scale(var(--row-icon-scale));
  }
</style>
