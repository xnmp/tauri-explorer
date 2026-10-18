/** Tiles row-grid wiring: interactions, sentinel, virtualization and reveal. */

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
  let rowContainsIndex = $state<((row: number) => boolean) | undefined>();
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
    containsIndex: (index: number) => rowContainsIndex?.(Math.floor((index + sentinelOffset) / getColumns())) ?? false,
    get rowContainsIndex() { return rowContainsIndex; },
    set rowContainsIndex(fn: ((row: number) => boolean) | undefined) { rowContainsIndex = fn; },
    // Bindable target for VirtualList's own scrollToIndex ($bindable).
    get rowScrollToIndex(): ((row: number) => void) | undefined {
      return rowScrollToIndex;
    },
    set rowScrollToIndex(fn: ((row: number) => void) | undefined) {
      rowScrollToIndex = fn;
    },
  };
}
