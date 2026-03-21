/**
 * Composable for shared item interaction logic across all view modes.
 * Extracts duplicated drag-and-drop, clipboard state, and context menu
 * handlers from FileItem, ListView, and TilesView.
 * Issue: fix/view-component-duplication
 */

import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { clipboardStore } from "$lib/state/clipboard.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { getDropSourcePaths, handleFileDrop } from "$lib/state/drop-operations";
import type { PaneNavigationContext } from "$lib/state/pane-context";

interface ItemInteractionsDeps {
  getExplorer: () => ExplorerInstance;
  getPaneNav: () => PaneNavigationContext | undefined;
  /** If true, selects unselected entries on right-click before opening menu (ListView/TilesView behavior) */
  selectOnContextMenu?: boolean;
}

export function useItemInteractions(deps: ItemInteractionsDeps) {
  const { getExplorer, getPaneNav, selectOnContextMenu = false } = deps;

  // Per-entry drop target state (keyed by path)
  let dropTargets = $state<Record<string, boolean>>({});
  let copyDropTargets = $state<Record<string, boolean>>({});

  // --- Drag handlers ---

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
    // Defer clear so sidebar's document-level dragend listener
    // can still read dragState.current for bookmark drops
    setTimeout(() => dragState.clear(), 0);
    const paneNav = getPaneNav();
    if (paneNav) {
      paneNav.refreshAllPanes();
    } else {
      getExplorer().refresh({ silent: true });
    }
  }

  function handleDragOver(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    if (!event.dataTransfer?.types.includes("application/x-explorer-path") && !dragState.readCrossWindow()) return;
    event.preventDefault();
    const copying = event.ctrlKey;
    if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? "copy" : "move";
    dropTargets[entry.path] = true;
    copyDropTargets[entry.path] = copying;
  }

  function handleDragLeave(entry: FileEntry): void {
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;
  }

  async function handleDrop(event: DragEvent, entry: FileEntry): Promise<void> {
    event.preventDefault();
    dropTargets[entry.path] = false;
    copyDropTargets[entry.path] = false;

    if (entry.kind !== "directory" || !event.dataTransfer) return;

    const sourcePaths = getDropSourcePaths(event.dataTransfer);
    if (sourcePaths.length === 0) return;

    const paneNav = getPaneNav();
    for (const sourcePath of sourcePaths) {
      if (sourcePath === entry.path) continue;
      if (entry.path.startsWith(sourcePath + "/")) continue;
      await handleFileDrop(sourcePath, entry.path, event.ctrlKey, {
        onRefresh: () => {
          if (paneNav) paneNav.refreshAllPanes();
          else getExplorer().refresh({ silent: true });
        },
      });
    }
  }

  // --- Drop target state ---

  function isDropTarget(path: string): boolean {
    return dropTargets[path] ?? false;
  }

  function isCopyDrop(path: string): boolean {
    return copyDropTargets[path] ?? false;
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
    handleDragOver,
    handleDragLeave,
    handleDrop,
    isDropTarget,
    isCopyDrop,
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

// --- Git status helper ---

/** Convert a git status string to its single-letter indicator */
export function gitStatusLetter(status: string): string {
  switch (status) {
    case "Modified": return "M";
    case "Untracked": return "U";
    case "Added": return "A";
    case "Deleted": return "D";
    case "Conflict": return "!";
    default: return "R";
  }
}
