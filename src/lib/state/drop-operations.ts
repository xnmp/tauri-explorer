/**
 * Shared drop handler logic for file drag-and-drop operations.
 * Extracted from FileItem.svelte and FileList.svelte to eliminate triplication.
 * Issue: tauri-explorer-9djf.1
 */

import { moveEntry, copyEntry, fetchDirectory } from "$lib/api/files";
import { conflictResolver } from "./conflict-resolver.svelte";
import { undoStore } from "./undo.svelte";
import { toastStore } from "./toast.svelte";
import { broadcastFileChange, parentDir } from "./file-events";
import { dragState } from "./drag.svelte";

export interface DropOptions {
  /** Refresh callback after drop completes */
  onRefresh: () => void;
}

/**
 * Extract the source path from a drop event, trying dataTransfer first,
 * then falling back to cross-window drag state.
 */
export function getDropSourcePath(dataTransfer: DataTransfer): string | null {
  let sourcePath = dataTransfer.getData("application/x-explorer-path");
  if (!sourcePath) {
    const crossWindow = dragState.readCrossWindow();
    if (crossWindow) sourcePath = crossWindow.path;
  }
  return sourcePath || null;
}

/**
 * Handle dropping a file/folder onto a target directory.
 * Implements: conflict detection, conflict resolution, copy/move dispatch,
 * undo tracking, toast notifications, and broadcastFileChange.
 */
export async function handleFileDrop(
  sourcePath: string,
  targetDir: string,
  isCopy: boolean,
  options: DropOptions,
): Promise<void> {
  const fileName = sourcePath.split("/").pop() || sourcePath;
  const targetName = targetDir.split("/").pop() || targetDir;

  // Check for naming conflict in target directory
  let overwrite = false;
  const dirResult = await fetchDirectory(targetDir);
  if (dirResult.ok) {
    const existingNames = new Set(dirResult.data.entries.map((e) => e.name));
    if (existingNames.has(fileName)) {
      const { choice } = await conflictResolver.prompt({
        fileName,
        sourcePath,
        remaining: 0,
      });
      if (choice === "skip" || choice === "cancel") return;
      if (choice === "overwrite") overwrite = true;
    }
  }

  const result = isCopy
    ? await copyEntry(sourcePath, targetDir, overwrite)
    : await moveEntry(sourcePath, targetDir, overwrite);

  if (result.ok) {
    if (isCopy) {
      toastStore.show(`Copied ${fileName} to ${targetName}`, "info");
    } else {
      undoStore.push({
        type: "move",
        sourcePath,
        destPath: result.data.path,
        originalDir: parentDir(sourcePath),
      });
      toastStore.show(`Moved ${fileName} to ${targetName}`, "info");
    }
    options.onRefresh();
    broadcastFileChange([parentDir(sourcePath), targetDir]);
  } else {
    console.error(`Failed to ${isCopy ? "copy" : "move"}:`, result.error);
    toastStore.error(result.error);
  }
}

/**
 * Handle dropping a file onto the background of the current directory.
 * Only supports move (not copy), guards against same-directory drops.
 */
export async function handleBackgroundDrop(
  sourcePath: string,
  currentPath: string,
  existingNames: Set<string>,
  options: DropOptions,
): Promise<void> {
  const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
  if (sourceDir === currentPath) return;

  const fileName = sourcePath.split("/").pop() || sourcePath;

  // Check for naming conflict in current directory
  let overwrite = false;
  if (existingNames.has(fileName)) {
    const { choice } = await conflictResolver.prompt({
      fileName,
      sourcePath,
      remaining: 0,
    });
    if (choice === "skip" || choice === "cancel") return;
    if (choice === "overwrite") overwrite = true;
  }

  const result = await moveEntry(sourcePath, currentPath, overwrite);
  if (result.ok) {
    const destName = currentPath.split("/").pop() || currentPath;
    undoStore.push({
      type: "move",
      sourcePath,
      destPath: result.data.path,
      originalDir: sourceDir,
    });
    toastStore.show(`Moved ${fileName} to ${destName}`, "info");
    options.onRefresh();
    broadcastFileChange([parentDir(sourcePath), currentPath]);
  } else {
    console.error("Failed to move:", result.error);
    toastStore.error(result.error);
  }
}
