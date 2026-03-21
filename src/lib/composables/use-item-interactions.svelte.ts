/**
 * Composable for shared item interaction logic across all view modes.
 * Extracts duplicated drag-and-drop, clipboard state, and context menu
 * handlers from FileItem, ListView, and TilesView.
 * Issue: fix/view-component-duplication, refactor/extract-drop-target
 */

import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { clipboardStore } from "$lib/state/clipboard.svelte";
import { dragState } from "$lib/state/drag.svelte";
import type { PaneNavigationContext } from "$lib/state/pane-context";
import { useDropTarget } from "./use-drop-target.svelte";

interface ItemInteractionsDeps {
  getExplorer: () => ExplorerInstance;
  getPaneNav: () => PaneNavigationContext | undefined;
  /** If true, selects unselected entries on right-click before opening menu (ListView/TilesView behavior) */
  selectOnContextMenu?: boolean;
}

export function useItemInteractions(deps: ItemInteractionsDeps) {
  const { getExplorer, getPaneNav, selectOnContextMenu = false } = deps;

  function refreshPanes(): void {
    const paneNav = getPaneNav();
    if (paneNav) paneNav.refreshAllPanes();
    else getExplorer().refresh({ silent: true });
  }

  // Shared drop-target behavior
  const dropTarget = useDropTarget({ onRefresh: refreshPanes });

  // --- Drag source handlers ---

  function handleDragStart(event: DragEvent, entry: FileEntry, isSelected: boolean): void {
    if (!event.dataTransfer) return;
    const explorer = getExplorer();
    const selectedEntries = explorer.getSelectedEntries();
    const isMulti = selectedEntries.length > 1 && isSelected;
    const paths = isMulti ? selectedEntries.map((e) => e.path) : [entry.path];

    event.dataTransfer.setData("application/x-explorer-path", entry.path);
    event.dataTransfer.setData("application/x-explorer-name", entry.name);
    event.dataTransfer.setData("application/x-explorer-kind", entry.kind);
    if (isMulti) {
      event.dataTransfer.setData("application/x-explorer-paths", JSON.stringify(paths));
    }
    event.dataTransfer.effectAllowed = "all";
    dragState.start({ path: entry.path, name: entry.name, kind: entry.kind, paths: isMulti ? paths : undefined });
  }

  function handleDragEnd(): void {
    setTimeout(() => dragState.clear(), 0);
    refreshPanes();
  }

  // --- Context menu ---

  function handleContextMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault();
    event.stopPropagation();
    const explorer = getExplorer();
    if (selectOnContextMenu && !explorer.isSelected(entry)) {
      explorer.selectEntry(entry, {});
    }
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  return {
    handleDragStart,
    handleDragEnd,
    handleDragOver: dropTarget.handleDragOver,
    handleDragLeave: dropTarget.handleDragLeave,
    handleDrop: dropTarget.handleDrop,
    isDropTarget: dropTarget.isDropTarget,
    isCopyDrop: dropTarget.isCopyDrop,
    handleContextMenu,
  };
}

// --- Clipboard helpers ---

export function isInClipboard(entry: FileEntry): boolean {
  return clipboardStore.content?.entries.some((e) => e.path === entry.path) ?? false;
}

export function isClipboardCut(entry: FileEntry): boolean {
  return isInClipboard(entry) && clipboardStore.isCut;
}