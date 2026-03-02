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
  let redoStack = $state<UndoAction[]>([]);

  return {
    // Accessors
    get canUndo() {
      return stack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    get stackSize() {
      return stack.length;
    },

    // Actions
    push(action: UndoAction): void {
      stack = [...stack, action];
      redoStack = []; // New action clears redo history
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
      redoStack = [...redoStack, action];
      return null;
    },

    /**
     * Re-execute the most recently undone action.
     * Returns an error message if the operation fails, null on success.
     */
    async redo(): Promise<string | null> {
      if (redoStack.length === 0) return "Nothing to redo";

      const action = redoStack[redoStack.length - 1];
      const result = await executeRedo(action);

      if (!result.ok) return result.error;

      redoStack = redoStack.slice(0, -1);
      stack = [...stack, action];
      return null;
    },

    /**
     * Clear all undo/redo history.
     */
    clear(): void {
      stack = [];
      redoStack = [];
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

/** Re-execute the original operation (redo = reverse of undo) */
async function executeRedo(
  action: UndoAction
): Promise<{ ok: true } | { ok: false; error: string }> {
  switch (action.type) {
    case "rename": {
      // Undo renamed back to oldName, so redo renames to newName again
      const parentDir = action.path.substring(0, action.path.lastIndexOf("/"));
      const currentPath = parentDir + "/" + action.oldName;
      return renameEntry(currentPath, action.newName);
    }
    case "move": {
      // Undo moved back to originalDir, so redo moves to destDir again
      const fileName = action.destPath.substring(action.destPath.lastIndexOf("/") + 1);
      const currentPath = action.originalDir + "/" + fileName;
      const destDir = action.destPath.substring(0, action.destPath.lastIndexOf("/"));
      return moveEntry(currentPath, destDir);
    }
    default: {
      const _exhaustive: never = action;
      return { ok: false, error: `Unknown redo action type: ${(_exhaustive as UndoAction).type}` };
    }
  }
}

export const undoStore = createUndoStore();
