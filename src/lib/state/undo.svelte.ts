/**
 * Global undo state management using Svelte 5 runes.
 * Issue: tauri-explorer-1k9k
 *
 * Extracted from explorer.svelte.ts to reduce god-object complexity.
 * Manages the undo stack for file operations (rename, move).
 * The stack is global to provide a unified undo experience.
 *
 * Cross-window: actions can be broadcast via BroadcastChannel so that
 * e.g. a drag-drop move is undoable from both source and destination windows.
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

const UNDO_CHANNEL = "explorer-undo-actions";
let channel: BroadcastChannel | null = null;

function createUndoStore() {
  let stack = $state<UndoAction[]>([]);
  let redoStack = $state<UndoAction[]>([]);

  // Listen for undo actions broadcast from other windows
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(UNDO_CHANNEL);
    channel.onmessage = (event: MessageEvent<UndoAction>) => {
      stack = [...stack, event.data];
      redoStack = [];
    };
  }

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

    /** Push an action and broadcast it to other windows. */
    pushAndBroadcast(action: UndoAction): void {
      stack = [...stack, action];
      redoStack = [];
      channel?.postMessage(action);
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
