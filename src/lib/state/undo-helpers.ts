/**
 * Undo/redo helper functions.
 * Pure functions extracted from explorer.svelte.ts.
 */

import type { UndoAction } from "./types";
import { basename } from "$lib/domain/path";

export function undoActionLabel(action: UndoAction): string {
  switch (action.type) {
    case "rename": return `Renamed ${action.oldName}`;
    case "move": return `Moved to ${basename(action.destPath)}`;
    case "copy": return `Copied ${basename(action.copiedPath)}`;
    case "batch": return action.label;
    case "delete": return `Deleted ${action.paths.length} item${action.paths.length > 1 ? "s" : ""}`;
  }
}
