/**
 * Pure execution logic for undo/redo operations.
 * Issue: #116
 *
 * Maps each UndoAction variant to the appropriate API call.
 * API dependencies are injected to keep this module framework-free and testable.
 */

import type { UndoAction } from "$lib/state/types";

/** Minimal result type matching the API contract (data is irrelevant for undo/redo). */
export type UndoResult = { ok: true } | { ok: false; error: string };

/** The subset of API functions needed for undo/redo execution. */
export interface UndoApiDeps {
  renameEntry: (path: string, newName: string) => Promise<UndoResult>;
  moveEntry: (source: string, destDir: string) => Promise<UndoResult>;
  deleteEntry: (path: string) => Promise<UndoResult>;
  deleteMultipleEntries: (paths: string[]) => Promise<UndoResult>;
  restoreFromTrash: (paths: string[]) => Promise<UndoResult>;
}

/**
 * Execute the reverse of the given action (undo).
 * Batch actions are undone in reverse order; failure at any step aborts.
 */
export async function executeUndo(
  action: UndoAction,
  api: UndoApiDeps
): Promise<UndoResult> {
  switch (action.type) {
    case "rename":
      return api.renameEntry(action.path, action.oldName);
    case "move":
      return api.moveEntry(action.destPath, action.originalDir);
    case "copy":
      return api.deleteEntry(action.copiedPath);
    case "batch": {
      for (let i = action.actions.length - 1; i >= 0; i--) {
        const result = await executeUndo(action.actions[i], api);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    case "delete":
      return api.restoreFromTrash(action.paths);
    default: {
      const _exhaustive: never = action;
      return { ok: false, error: `Unknown undo action type: ${(_exhaustive as UndoAction).type}` };
    }
  }
}

/**
 * Re-execute the original operation (redo = reverse of undo).
 * Batch actions are redone in original order; failure at any step aborts.
 */
export async function executeRedo(
  action: UndoAction,
  api: UndoApiDeps
): Promise<UndoResult> {
  switch (action.type) {
    case "rename": {
      const parentDir = action.path.substring(0, action.path.lastIndexOf("/"));
      const currentPath = parentDir + "/" + action.oldName;
      return api.renameEntry(currentPath, action.newName);
    }
    case "move": {
      const fileName = action.destPath.substring(action.destPath.lastIndexOf("/") + 1);
      const currentPath = action.originalDir + "/" + fileName;
      const destDir = action.destPath.substring(0, action.destPath.lastIndexOf("/"));
      return api.moveEntry(currentPath, destDir);
    }
    case "copy":
      return api.restoreFromTrash([action.copiedPath]);
    case "batch": {
      for (const a of action.actions) {
        const result = await executeRedo(a, api);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    case "delete":
      return api.deleteMultipleEntries(action.paths);
    default: {
      const _exhaustive: never = action;
      return { ok: false, error: `Unknown redo action type: ${(_exhaustive as UndoAction).type}` };
    }
  }
}
