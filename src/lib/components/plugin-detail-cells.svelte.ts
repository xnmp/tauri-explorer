import type { Component } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import type { PluginDetailColumn } from "$lib/domain/plugin-detail-columns";

let lazy = $state.raw<Component<{ entry: FileEntry; columns: readonly PluginDetailColumn[] }>>();
let loading: Promise<unknown> | undefined;

/**
 * Startup seam for plugin Details cells (#1523): the row-cell component loads
 * the first time a row shows a plugin column (the startup bundle has almost no
 * headroom), and rows render it reactively once loaded.
 */
export function pluginDetailCells(): typeof lazy {
  // A failed chunk load is retried by the next row that asks.
  loading ??= import("./PluginDetailCells.svelte").then((module) => (lazy = module.default), () => { loading = undefined; });
  return lazy;
}
