/**
 * Composable for handling native (external) file drops.
 *
 * Extracts the drop handling logic from +page.svelte: modifier key tracking,
 * Tauri onDragDropEvent setup, and position-based drop target resolution.
 */

import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { useExternalDrop } from "$lib/composables/use-external-drop.svelte";
import { resolveDropTarget, highlightTarget, clearHighlights } from "$lib/composables/use-native-drop-target.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { handleFileDropMany } from "$lib/state/drop-operations";
import { isCopyModifier as isCopyMod } from "$lib/domain/platform";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { terminalPanelStore } from "$lib/state/terminal.svelte";
import { parentDir, isInsideDir, samePath, splitFlattenedUriList } from "$lib/domain/path";

export interface NativeDropDeps {
  getActiveExplorer: () => ExplorerInstance | undefined;
  refreshAllPanes: () => void;
}

export function useNativeDropHandler(deps: NativeDropDeps) {
  let copyModifierHeld = false;

  async function handleNativeDrop(rawPaths: string[], position: { x: number; y: number }): Promise<void> {
    clearHighlights();

    const explorer = deps.getActiveExplorer();
    if (!explorer) return;

    const target = resolveDropTarget(position);

    // WebKitGTK flattens a multi-file in-app drag into ONE concatenated
    // uri-list string (#253) — recover the individual paths first.
    const paths = rawPaths.flatMap(splitFlattenedUriList);

    // Check both in-memory (same-window) and localStorage (cross-window) drag state
    const dragData = dragState.current ?? dragState.readCrossWindow();
    const internalPaths = dragData?.paths
      ? dragData.paths
      : dragData?.path
        ? [dragData.path]
        : null;
    const isInternalDrag = internalPaths !== null &&
      paths.length > 0 &&
      internalPaths.includes(paths[0]);

    // Internal drags always move; only external drops respect the copy modifier
    // (keyboard focus is lost during native drag, making copyModifierHeld unreliable)
    const isCopy = !isInternalDrag && copyModifierHeld;

    // Terminal drop: type the paths into the shell prompt (#265).
    if (target?.type === "terminal") {
      const sourcePaths = isInternalDrag ? internalPaths! : paths;
      terminalPanelStore.insertPaths(sourcePaths);
      dragState.clear();
      return;
    }

    // Sidebar bookmark drop
    if (target?.type === "sidebar") {
      const sourcePaths = isInternalDrag ? internalPaths! : paths;
      for (const p of sourcePaths) {
        bookmarksStore.addBookmark(p);
      }
      dragState.clear();
      return;
    }

    // Determine source paths (validated internal drag state or external paths)
    const sourcePaths = isInternalDrag ? internalPaths! : paths;

    const dropOptions = {
      onRefresh: deps.refreshAllPanes,
      broadcastToOtherWindows: isInternalDrag,
    };

    // Drop onto a specific folder or tab
    if (target?.type === "folder" || target?.type === "tab") {
      // Skip dropping onto self or into one's own descendant; multi-item
      // drops are a single undoable batch (#163).
      const valid = sourcePaths.filter((sourcePath) => !isInsideDir(target.path, sourcePath));
      await handleFileDropMany(valid, target.path, isCopy, dropOptions);
      dragState.clear();
      return;
    }

    // Background drop — move/copy to the target pane's directory
    const destDir = target?.path || explorer.currentPath;

    const movable = sourcePaths.filter((path) => !samePath(parentDir(path), destDir));
    await handleFileDropMany(movable, destDir, isCopy, dropOptions);

    dragState.clear();
  }

  function handleNativeOver(position: { x: number; y: number }): void {
    const explorer = deps.getActiveExplorer();
    if (explorer) {
      const dragData = dragState.current ?? dragState.readCrossWindow();
      if (dragData) {
        const target = resolveDropTarget(position);
        if (target?.type === "background") {
          const destDir = target.path || explorer.currentPath;
          const paths = dragData.paths ?? [dragData.path];
          if (paths.every((p) => samePath(parentDir(p), destDir))) {
            clearHighlights();
            return;
          }
        }
      }
    }
    highlightTarget(position);
  }

  const externalDrop = useExternalDrop({
    onDrop: handleNativeDrop,
    onOver: handleNativeOver,
    onLeave: clearHighlights,
  });

  function trackModifierDown(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }
  function trackModifierUp(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }

  function blockWebviewDefaultDnD(event: DragEvent) {
    event.preventDefault();
  }

  function setup(): void {
    externalDrop.setup();
    window.addEventListener("keydown", trackModifierDown, true);
    window.addEventListener("keyup", trackModifierUp, true);
    window.addEventListener("dragover", blockWebviewDefaultDnD, { capture: true });
    window.addEventListener("drop", blockWebviewDefaultDnD, { capture: true });
  }

  function cleanup(): void {
    externalDrop.cleanup();
    window.removeEventListener("keydown", trackModifierDown, true);
    window.removeEventListener("keyup", trackModifierUp, true);
    window.removeEventListener("dragover", blockWebviewDefaultDnD, { capture: true });
    window.removeEventListener("drop", blockWebviewDefaultDnD, { capture: true });
  }

  return { setup, cleanup };
}
