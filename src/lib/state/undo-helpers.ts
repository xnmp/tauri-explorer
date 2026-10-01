/**
 * Undo/redo helper functions.
 * Pure functions extracted from explorer.svelte.ts.
 */

import type { HistoryAction } from "$lib/domain/file-history";
import { basename } from "$lib/domain/path";

export function undoActionLabel(action: HistoryAction): string {
  switch (action.type) {
    case "rename": return `Renamed ${action.oldName}`;
    case "move": return `Moved to ${basename(action.destPath)}`;
    case "copy": return `Copied ${basename(action.copiedPath)}`;
    case "replacement": return `Replaced ${basename(action.path)}`;
    case "batch": return action.label;
    case "delete": return `Deleted ${action.paths.length} item${action.paths.length > 1 ? "s" : ""}`;
  }
}
