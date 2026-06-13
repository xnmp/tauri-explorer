/**
 * Undo/redo helper functions.
 * Pure functions extracted from explorer.svelte.ts.
 */

import type { UndoAction } from "./types";
import { parentDir, basename } from "$lib/domain/path";

/** Compute directories affected by an undo/redo action for broadcasting. */
export function getAffectedDirs(action: UndoAction): string[] {
  switch (action.type) {
    case "rename":
      return [parentDir(action.path)];
    case "move":
      return [action.originalDir, parentDir(action.destPath)];
    case "copy":
      return [action.parentDir];
    case "batch":
      return action.actions.flatMap(getAffectedDirs);
    case "delete":
      return [action.parentDir];
  }
}

export function undoActionLabel(action: UndoAction): string {
  switch (action.type) {
    case "rename": return `Renamed ${action.oldName}`;
    case "move": return `Moved to ${basename(action.destPath)}`;
    case "copy": return `Copied ${basename(action.copiedPath)}`;
    case "batch": return action.label;
    case "delete": return `Deleted ${action.paths.length} item${action.paths.length > 1 ? "s" : ""}`;
  }
}
