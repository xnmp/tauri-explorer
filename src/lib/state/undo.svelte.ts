/**
 * Global undo state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages the undo stack for file operations (rename, move).
 * The stack is global to provide a unified undo experience.
 */

import { renameEntry, moveEntry, restoreFromTrash, deleteMultipleEntries, deleteEntry } from "$lib/api/files";
import { executeUndo, executeRedo, type UndoApiDeps } from "$lib/domain/undo-operations";
import type { UndoAction } from "./types";

/** Concrete API bindings for undo/redo execution. */
const undoApi: UndoApiDeps = {
  renameEntry,
  moveEntry,
  deleteEntry,
  deleteMultipleEntries,
  restoreFromTrash,
};

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
     * Returns { error } on failure, { action } on success (for broadcasting affected dirs).
     */
    async undo(): Promise<{ error: string } | { action: UndoAction }> {
      if (stack.length === 0) return { error: "Nothing to undo" };

      const action = stack[stack.length - 1];
      const result = await executeUndo(action, undoApi);

      if (!result.ok) return { error: result.error };

      stack = stack.slice(0, -1);
      redoStack = [...redoStack, action];
      return { action };
    },

    /**
     * Re-execute the most recently undone action.
     * Returns { error } on failure, { action } on success (for broadcasting affected dirs).
     */
    async redo(): Promise<{ error: string } | { action: UndoAction }> {
      if (redoStack.length === 0) return { error: "Nothing to redo" };

      const action = redoStack[redoStack.length - 1];
      const result = await executeRedo(action, undoApi);

      if (!result.ok) return { error: result.error };

      redoStack = redoStack.slice(0, -1);
      stack = [...stack, action];
      return { action };
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

export const undoStore = createUndoStore();
