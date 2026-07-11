/**
 * Pure execution logic for undo/redo operations.
 * Issue: #116
 *
 * Maps each UndoAction variant to the appropriate API call.
 * API dependencies are injected to keep this module framework-free and testable.
 */

import { parentDir, basename, joinPath } from "./path";

/** Undoable action types. Lives in domain — these describe invertible
 *  filesystem operations, independent of any store (#278). */
export type UndoAction =
  | { type: "rename"; path: string; oldName: string; newName: string }
  | { type: "move"; sourcePath: string; destPath: string; originalDir: string }
  | { type: "copy"; copiedPath: string; parentDir: string }
  | { type: "batch"; actions: UndoAction[]; label: string }
  | { type: "delete"; paths: string[]; parentDir: string };

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
      const currentPath = joinPath(parentDir(action.path), action.oldName);
      return api.renameEntry(currentPath, action.newName);
    }
    case "move": {
      const fileName = basename(action.destPath);
      const currentPath = joinPath(action.originalDir, fileName);
      const destDir = parentDir(action.destPath);
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
