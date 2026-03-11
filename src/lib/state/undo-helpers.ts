/**
 * Undo/redo helper functions.
 * Pure functions extracted from explorer.svelte.ts.
 */

import type { UndoAction } from "./types";

/** Compute directories affected by an undo/redo action for broadcasting. */
export function getAffectedDirs(action: UndoAction): string[] {
  switch (action.type) {
    case "rename":
      return [action.path.substring(0, action.path.lastIndexOf("/"))];
    case "move":
      return [action.originalDir, action.destPath.substring(0, action.destPath.lastIndexOf("/"))];
    case "delete":
      return [action.parentDir];
  }
}

export function undoActionLabel(action: UndoAction): string {
  switch (action.type) {
    case "rename": return `Renamed ${action.oldName}`;
    case "move": return `Moved to ${action.destPath.split("/").pop()}`;
    case "delete": return `Deleted ${action.paths.length} item${action.paths.length > 1 ? "s" : ""}`;
  }
}
