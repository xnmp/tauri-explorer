/**
 * Global undo state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages the undo stack for file operations (rename, move).
 * The stack is global to provide a unified undo experience.
 */

import { renameEntry, moveEntry } from "$lib/api/files";
import type { UndoAction } from "./types";

function createUndoStore() {
  let stack = $state<UndoAction[]>([]);

  return {
    // Accessors
    get canUndo() {
      return stack.length > 0;
    },
    get stackSize() {
      return stack.length;
    },

    // Actions
    push(action: UndoAction): void {
      stack = [...stack, action];
    },

    /**
     * Execute the most recent undo action and remove it from the stack.
     * Returns an error message if the operation fails, null on success.
     */
    async undo(): Promise<string | null> {
      if (stack.length === 0) return "Nothing to undo";

      const action = stack[stack.length - 1];
      const result = await executeUndo(action);

      if (!result.ok) return result.error;

      stack = stack.slice(0, -1);
      return null;
    },

    /**
     * Clear all undo history.
     */
    clear(): void {
      stack = [];
    },
  };
}

async function executeUndo(
  action: UndoAction
): Promise<{ ok: true } | { ok: false; error: string }> {
  switch (action.type) {
    case "rename":
      return renameEntry(action.path, action.oldName);
    case "move":
      return moveEntry(action.destPath, action.originalDir);
    default: {
      const _exhaustive: never = action;
      return { ok: false, error: `Unknown undo action type: ${(_exhaustive as UndoAction).type}` };
    }
  }
}

export const undoStore = createUndoStore();
