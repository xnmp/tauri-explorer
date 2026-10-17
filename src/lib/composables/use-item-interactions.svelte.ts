/**
 * Composable for shared item interaction logic across all view modes.
 * Extracts duplicated drag-and-drop, clipboard state, and context menu
 * handlers from FileItem, ListView, and TilesView.
 * Issue: fix/view-component-duplication, refactor/extract-drop-target
 */

import { isWindows } from "$lib/domain/platform";
import { operationDrag } from "$lib/domain/file-operation-selection";
import { toastStore } from "$lib/state/toast.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { clipboardStore } from "$lib/state/clipboard.svelte";
import { createHtml5FileDrag } from "$lib/state/html5-file-drag.svelte";
import { useDropTarget } from "./use-drop-target.svelte";
import { createDragGhost, reducedDragSource } from "./use-pointer-drag.svelte";

interface ItemInteractionsDeps {
  getExplorer: () => ExplorerInstance;
  /** Refresh every pane that may show an affected directory after a drop.
   *  Defaults to refreshing only the owning pane. */
  refreshPanes?: () => void;
  /** If true, selects unselected entries on right-click before opening menu (ListView/TilesView behavior) */
  selectOnContextMenu?: boolean;
}

export function useItemInteractions(deps: ItemInteractionsDeps) {
  const { getExplorer, selectOnContextMenu = false } = deps;

  function refreshPanes(): void {
    if (deps.refreshPanes) deps.refreshPanes();
    else getExplorer().refresh({ silent: true });
  }

  // Shared drop-target behavior
  const dropTarget = useDropTarget({ onRefresh: refreshPanes });

  const sourceDrag = createHtml5FileDrag(refreshPanes, "move");

  // --- Drag source handlers ---

  function handleDragStart(event: DragEvent, entry: FileEntry, isSelected: boolean): void {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const explorer = getExplorer();
    const selectedEntries = explorer.getSelectedEntries();
    const reduced = operationDrag(isSelected ? selectedEntries : [entry], entry, isWindows, explorer.displayEntries);
    if (!reduced.ok) { event.preventDefault(); toastStore.error(reduced.error); return; }
    const originalPath = entry.path;
    entry = reduced.primary;
    const paths = reduced.entries.map(e => e.path);
    const isMulti = paths.length > 1;

    sourceDrag.start(event, { path: entry.path, name: entry.name, kind: entry.kind, paths: isMulti ? paths : undefined }, () => {
      // Custom drag ghost (#258, #269): the engine's default drag image is an
      // opaque snapshot of the row under the cursor. Replace it for EVERY drag —
      // multi-drags get a fanned stack + count badge, single drags the icon +
      // name — so all ghosts share the same translucency and the drop target
      // stays visible underneath. The element must be rendered when
      // setDragImage snapshots it — park it off-screen and remove it on the
      // next tick.
      if (typeof document !== "undefined" && typeof transfer.setDragImage === "function") {
        const ghost = createDragGhost(
          originalPath === entry.path ? event.currentTarget as HTMLElement : reducedDragSource(event.currentTarget as HTMLElement, entry.path),
          isMulti ? `${paths.length} items` : entry.name,
          isMulti ? paths.length : 1,
        );
        ghost.style.left = "-1000px";
        ghost.style.top = "-1000px";
        transfer.setDragImage(ghost, 30, 30);
        setTimeout(() => ghost.remove(), 0);
      }
    });
  }

  const handleDragEnd = sourceDrag.end;

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
    trackDragSource: sourceDrag.trackSource,
    handleDragOver: dropTarget.handleDragOver,
    handleDragEnter: dropTarget.handleDragEnter,
    handleDragLeave: dropTarget.handleDragLeave,
    handleDrop: dropTarget.handleDrop,
    releaseDropTarget: dropTarget.releaseDropTarget,
    isDropTarget: dropTarget.isDropTarget,
    isCopyDrop: dropTarget.isCopyDrop,
    handleContextMenu,
  };
}

// --- Clipboard helpers ---

export function isInClipboard(entry: FileEntry): boolean {
  return clipboardStore.pathSet.has(entry.path);
}

export function isClipboardCut(entry: FileEntry): boolean {
  return isInClipboard(entry) && clipboardStore.isCut;
}
