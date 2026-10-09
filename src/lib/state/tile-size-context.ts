/**
 * The tile size of the pane a component renders in, as Svelte context.
 * `PluginFileView` provides it, so `ui/file-tiles` inside a plugin view
 * follows the folder's size even when the plugin passes no `size` (plugins
 * share the host's Svelte runtime, so context crosses the plugin boundary).
 * The reader is a function: calling it inside a derivation tracks changes.
 */
import { getContext, setContext } from "svelte";
import type { ThumbnailSize } from "$lib/domain/tile-layout";

const TILE_SIZE_KEY = Symbol("pane-tile-size");

export type TileSizeReader = () => ThumbnailSize;

/** Call during component init. */
export function setTileSizeContext(read: TileSizeReader): void {
  setContext(TILE_SIZE_KEY, read);
}

/** Call during component init; undefined outside a provider. */
export function getTileSizeContext(): TileSizeReader | undefined {
  return getContext<TileSizeReader | undefined>(TILE_SIZE_KEY);
}
