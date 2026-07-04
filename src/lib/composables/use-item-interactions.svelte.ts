/**
 * Composable for shared item interaction logic across all view modes.
 * Extracts duplicated drag-and-drop, clipboard state, and context menu
 * handlers from FileItem, ListView, and TilesView.
 * Issue: fix/view-component-duplication, refactor/extract-drop-target
 */

import type { FileEntry } from "$lib/domain/file";
import { isMac, isWindows } from "$lib/domain/platform";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { clipboardStore } from "$lib/state/clipboard.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { useDropTarget } from "./use-drop-target.svelte";
import { startExternalDrag } from "./use-external-drag.svelte";

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
    // file:// URIs for external apps (Finder, VSCode, etc.) via native pasteboard bridge
    const uriList = paths.map((p) => "file://" + encodeURI(p)).join("\r\n");
    event.dataTransfer.setData("text/uri-list", uriList);
    event.dataTransfer.effectAllowed = "all";

    dragState.start({ path: entry.path, name: entry.name, kind: entry.kind, paths: isMulti ? paths : undefined });

    // Per-engine in-app drag strategy:
    //
    // - Windows (WebView2 = Chromium): use plain HTML5 DnD, exactly like the dev
    //   browser. The DOM dragover/drop handlers on folders, miller columns,
    //   breadcrumbs, tabs and the sidebar all work, and the engine renders a
    //   native drag ghost. We must NOT start the OLE drag here: that turns the
    //   gesture into an OS-level drag which Tauri (dragDropEnabled defaults true)
    //   intercepts, suppressing the DOM drag events — which is exactly what left
    //   the cursor stuck on "cancel" and only the polling-based sidebar working.
    //   Trade-off: dragging files OUT to Explorer needs OLE and is not supported
    //   on Windows for now (none of the in-app targets need it).
    //
    // - Linux (WebKitGTK): in-app DnD goes through the native drag session +
    //   Tauri onDragDropEvent (see use-native-drop-handler), so start it here.
    //
    // - macOS: handled by the pointer-drag composable, not this HTML5 path.
    if (!isMac && !isWindows) {
      void startExternalDrag(paths);
    }
  }

  function handleDragEnd(): void {
    // Sidebar's document-level dragend runs in capture phase and reads
    // `dragState.current` before this bubble-phase handler fires, so
    // clearing synchronously is safe.
    dragState.clear();
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
  return clipboardStore.pathSet.has(entry.path);
}

export function isClipboardCut(entry: FileEntry): boolean {
  return isInClipboard(entry) && clipboardStore.isCut;
}
