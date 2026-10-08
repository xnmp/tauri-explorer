<!--
  TileVisual - What one tile shows: its icon block (image/video thumbnail,
  folder preview or file icon, plus the video marker) and its name. Shared by
  TilesView and FileTiles; the surrounding cell and TileSurface supply the
  interaction and chrome. The name defaults to the explorer-free label; the
  Tiles view passes its rename-capable EntryName instead.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { TileLayout } from "$lib/domain/tile-layout";
  import { getFileIconColor, isImageFile, isVideoFile, isVideoMediaFile } from "$lib/domain/file-types";
  import EntryNameLabel from "./EntryNameLabel.svelte";
  import FileIcon from "./FileIcon.svelte";
  import FolderThumbnail from "./FolderThumbnail.svelte";
  import ThumbnailImage from "./ThumbnailImage.svelte";
  import VideoIndicator from "./VideoIndicator.svelte";

  interface Props {
    entry: FileEntry;
    layout: TileLayout;
    /** The video's thumbnail failed before (e.g. no ffmpeg): show its icon. */
    videoUnavailable?: boolean;
    onvideounavailable?: () => void;
    name?: Snippet;
  }

  let { entry, layout, videoUnavailable = false, onvideounavailable, name }: Props = $props();
  const iconColor = $derived(getFileIconColor(entry));
</script>

<div class="tile-icon" style:color={iconColor} data-drag-icon>
  {#if isImageFile(entry)}
    <ThumbnailImage path={entry.path} size={layout.displaySize} genSize={layout.genSize} quality={layout.quality} fallbackColor={iconColor} />
  {:else if isVideoFile(entry) && !videoUnavailable}
    <ThumbnailImage kind="video" path={entry.path} size={layout.displaySize} genSize={layout.genSize} quality={layout.quality} fallbackColor={iconColor} onunavailable={onvideounavailable} />
  {:else if entry.kind === "directory" && layout.showFolderThumbnails}
    <FolderThumbnail path={entry.path} modified={entry.modified} size={layout.displaySize} genSize={layout.genSize} quality={layout.quality}>
      <FileIcon {entry} size="large" />
    </FolderThumbnail>
  {:else}
    <FileIcon {entry} size="large" />
  {/if}
  {#if isVideoMediaFile(entry)}
    <span class="video-thumbnail-marker"><VideoIndicator /></span>
  {/if}
</div>
<span data-drag-name>{#if name}{@render name()}{:else}<EntryNameLabel name={entry.name} variant="tiles" />{/if}</span>

<style>
  .video-thumbnail-marker {
    position: absolute;
    bottom: 2px;
    right: 2px;
    line-height: 0;
    pointer-events: none;
  }
</style>
