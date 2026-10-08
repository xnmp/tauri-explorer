/**
 * The tile size a folder shows at: its per-folder override (set by "Tile
 * View: Set Size" and the context menu's Icon Size), else the global
 * `thumbnailSize` setting. One resolution for the Tiles view, the context
 * menu and plugin file views (`FileViewPane.tileSize`), so they cannot
 * disagree. Both stores are rune state: reading these inside a derivation
 * tracks the setting and the folder's override.
 */
import { paneTileSize, type PaneTileSize, type ThumbnailSize } from "$lib/domain/tile-layout";
import { folderViewsStore } from "./folder-views.svelte";
import { settingsStore } from "./settings.svelte";

export function folderTileSize(directory: string): ThumbnailSize {
  return folderViewsStore.getThumbnailSize(directory, settingsStore.thumbnailSize);
}

/** The folder's tile size as the plugin SDK exposes it. */
export function folderPaneTileSize(directory: string): PaneTileSize {
  return paneTileSize(folderTileSize(directory));
}
