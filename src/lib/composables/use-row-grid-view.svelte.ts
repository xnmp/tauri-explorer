/**
 * Shared row-grid virtualization wiring for the grid-style views (List, Tiles).
 *
 * ListView and TilesView both render entries as a row-major virtual grid: the
 * entry list (plus an optional new-folder sentinel) is chunked into fixed-height
 * rows of N columns, and each row is one VirtualList item. Everything except the
 * column derivation is identical between the two, so it lives here:
 *   - useItemInteractions (DnD, context menu with select-on-right-click)
 *   - usePointerDrag (only on platforms that need it)
 *   - the new-folder sentinel splice + sentinelOffset (#257)
 *   - chunkIntoRows(gridEntries, columns)
 *   - the displayEntries-index -> row-index scrollToIndex mapping
 *
 * DetailsView deliberately does NOT use this: it wires interactions per-row via
 * FileItem rather than as a single grid, so its needs differ.
 *
 * Reactivity: `getColumns` must stay a lazy getter so the caller's $derived
 * column count re-runs `rows`/`scrollToIndex` on change. Do not snapshot it.
 *
 * Issue: refactor/row-grid-view, #293
 */

import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { chunkIntoRows, type VirtualRow } from "$lib/domain/virtual-layout";
import { usesPointerDrag } from "$lib/domain/platform";
import { useItemInteractions } from "./use-item-interactions.svelte";
import { usePointerDrag } from "./use-pointer-drag.svelte";
import { NEW_FOLDER_SENTINEL } from "$lib/components/InlineNewFolder.svelte";

interface RowGridViewDeps {
  getExplorer: () => ExplorerInstance;
  /** Refresh every pane that may show an affected directory after a drop. */
  refreshPanes: () => void;
  /** Lazy getter for the current column count (view-specific derivation). */
  getColumns: () => number;
}

export function useRowGridView(deps: RowGridViewDeps) {
  const { getExplorer, refreshPanes, getColumns } = deps;

  // Shared item interactions (DnD, context menu with select-on-right-click)
  const interactions = useItemInteractions({
    getExplorer,
    refreshPanes,
    selectOnContextMenu: true,
  });

  const pointerDrag = usesPointerDrag ? usePointerDrag({ getExplorer, refreshPanes }) : null;

  // The new-folder editor rides INSIDE the virtual grid as a sentinel first
  // cell (#257) — not as a band above the scroller. Real-entry indices shift
  // by one while it's present (see sentinelOffset).
  const gridEntries = $derived(
    getExplorer().isCreatingFolder
      ? [NEW_FOLDER_SENTINEL, ...getExplorer().displayEntries]
      : getExplorer().displayEntries,
  );
  const sentinelOffset = $derived(getExplorer().isCreatingFolder ? 1 : 0);

  const rows = $derived(chunkIntoRows(gridEntries, getColumns()));

  // VirtualList assigns its own row scroller into this via bind:. The outward
  // scrollToIndex maps a displayEntries index to its row and forwards.
  let rowScrollToIndex = $state<((row: number) => void) | undefined>();

  function scrollToIndex(index: number): void {
    rowScrollToIndex?.(Math.floor((index + sentinelOffset) / getColumns()));
  }

  return {
    interactions,
    pointerDrag,
    get gridEntries(): readonly FileEntry[] {
      return gridEntries;
    },
    get sentinelOffset(): number {
      return sentinelOffset;
    },
    get rows(): VirtualRow<FileEntry>[] {
      return rows;
    },
    scrollToIndex,
    // Bindable target for VirtualList's own scrollToIndex ($bindable).
    get rowScrollToIndex(): ((row: number) => void) | undefined {
      return rowScrollToIndex;
    },
    set rowScrollToIndex(fn: ((row: number) => void) | undefined) {
      rowScrollToIndex = fn;
    },
  };
}
