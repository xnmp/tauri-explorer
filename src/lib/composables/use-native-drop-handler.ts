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
import { handleFileDrop } from "$lib/state/drop-operations";
import { isCopyModifier as isCopyMod } from "$lib/domain/platform";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { copyEntry, moveEntry } from "$lib/api/files";
import { broadcastFileChange } from "$lib/state/file-events";
import { parentDir } from "$lib/domain/path";

export interface NativeDropDeps {
  getActiveExplorer: () => ExplorerInstance | undefined;
  refreshAllPanes: () => void;
}

export function useNativeDropHandler(deps: NativeDropDeps) {
  let copyModifierHeld = false;

  async function handleNativeDrop(paths: string[], position: { x: number; y: number }): Promise<void> {
    clearHighlights();

    const explorer = deps.getActiveExplorer();
    if (!explorer) return;

    const target = resolveDropTarget(position);

    const internalPaths = dragState.current?.paths
      ? dragState.current.paths
      : dragState.current?.path
        ? [dragState.current.path]
        : null;
    const isInternalDrag = internalPaths !== null &&
      paths.length > 0 &&
      internalPaths.includes(paths[0]);

    // Internal drags always move; only external drops respect the copy modifier
    // (keyboard focus is lost during native drag, making copyModifierHeld unreliable)
    const isCopy = !isInternalDrag && copyModifierHeld;

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

    // Drop onto a specific folder
    if (target?.type === "folder") {
      for (const sourcePath of sourcePaths) {
        if (sourcePath === target.path) continue;
        if (target.path.startsWith(sourcePath + "/")) continue;
        await handleFileDrop(sourcePath, target.path, isCopy, {
          onRefresh: deps.refreshAllPanes,
        });
      }
      dragState.clear();
      return;
    }

    // Background drop — move/copy to the target pane's directory
    const destDir = target?.path || explorer.currentPath;
    const operation = isCopy ? copyEntry : moveEntry;
    const opName = isCopy ? "copy" : "move";
    const affectedDirs = new Set<string>();
    affectedDirs.add(destDir);

    for (const path of sourcePaths) {
      const sourceDir = parentDir(path);
      if (sourceDir === destDir) continue;
      affectedDirs.add(sourceDir);
      const result = await operation(path, destDir);
      if (!result.ok) {
        console.error(`Failed to ${opName} dropped file:`, result.error);
      }
    }

    dragState.clear();
    deps.refreshAllPanes();
    broadcastFileChange([...affectedDirs]);
  }

  const externalDrop = useExternalDrop({
    onDrop: handleNativeDrop,
    onOver: highlightTarget,
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
