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

interface HistoryEntry { readonly action: UndoAction }
export interface UndoCompletion { action?: UndoAction; error?: string }

function snapshot(action: UndoAction): UndoAction {
  if (action.type === "batch") return { ...action, actions: action.actions.map(snapshot) };
  if (action.type === "delete") return { ...action, paths: [...action.paths] };
  return { ...action };
}

function createUndoStore() {
  let stack = $state.raw<HistoryEntry[]>([]);
  let redoStack = $state.raw<HistoryEntry[]>([]);
  let running = $state(false);
  let generation = 0;
  let branch = 0;

  function push(action: UndoAction): void {
    stack = [...stack, { action: snapshot(action) }];
    redoStack = [];
    branch += 1;
  }

  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(UNDO_CHANNEL);
    channel.onmessage = (event: MessageEvent<UndoAction>) => push(event.data);
  }

  async function perform(direction: "undo" | "redo"): Promise<UndoCompletion> {
    if (running) return { error: "An undo or redo operation is already in progress" };
    const entry = (direction === "undo" ? stack : redoStack).at(-1);
    if (!entry) return { error: direction === "undo" ? "Nothing to undo" : "Nothing to redo" };
    const admittedGeneration = generation;
    const admittedBranch = branch;
    running = true;
    try {
      const result = await (direction === "undo" ? executeUndo : executeRedo)(entry.action, undoApi);
      // Clearing history retires this reservation without cancelling accepted
      // filesystem work. Intervening pushes invalidate the old redo branch.
      if (generation === admittedGeneration) {
        const settle = (entries: HistoryEntry[]) => entries.flatMap((candidate) =>
          candidate !== entry ? [candidate] : result.remaining ? [{ action: result.remaining }] : []);
        if (direction === "undo") {
          stack = settle(stack);
          if (result.completed && branch === admittedBranch) redoStack = [...redoStack, { action: result.completed }];
        } else {
          // A new command discards the obsolete redo branch, but cannot
          // discard unfinished work from this already-admitted redo. Clear
          // explicitly retires both through the generation check above.
          redoStack = branch === admittedBranch
            ? settle(redoStack)
            : result.remaining ? [{ action: result.remaining }] : [];
          if (result.completed) stack = [...stack, { action: result.completed }];
        }
      }
      // A partial error still reports its completed effect for directory
      // invalidation; the history reservation retains only unfinished work.
      return {
        ...(result.completed ? { action: result.completed } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    } finally {
      running = false;
    }
  }

  return {
    get canUndo() { return !running && stack.length > 0; },
    get canRedo() { return !running && redoStack.length > 0; },
    get stackSize() { return stack.length; },
    push,
    pushAndBroadcast(action: UndoAction): void {
      const owned = snapshot(action);
      push(owned);
      channel?.postMessage(owned);
    },
    undo: () => perform("undo"),
    redo: () => perform("redo"),
    clear(): void {
      generation += 1;
      branch += 1;
      stack = [];
      redoStack = [];
    },
  };
}

export const undoStore = createUndoStore();
