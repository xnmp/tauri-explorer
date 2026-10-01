/** Browser-only filesystem simulation for history UI tests.
 * Native windows execute and settle history in Rust. */

import { parentDir, basename, joinPath } from "$lib/domain/path";
import { fileBatchError, type FileBatchResult } from "$lib/domain/file-batch-outcome";

import type { UndoAction } from "$lib/domain/file-history";

/** Minimal result type matching the API contract (data is irrelevant for undo/redo). */
export type UndoResult = { ok: true } | { ok: false; error: string };

/** The subset of API functions needed for undo/redo execution. */
export interface UndoApiDeps {
  renameEntry: (path: string, newName: string) => Promise<UndoResult>;
  moveEntry: (source: string, destDir: string) => Promise<UndoResult>;
  deleteEntry: (path: string) => Promise<UndoResult>;
  deleteMultipleEntries: (paths: string[]) => Promise<FileBatchResult>;
  restoreFromTrash: (paths: string[]) => Promise<FileBatchResult>;
}

/** An inverse may make progress before failing. Retry only `remaining`. */
export interface UndoExecution {
  completed: UndoAction | null;
  remaining: UndoAction | null;
  error: string | null;
}

type Direction = "undo" | "redo";

function settled(action: UndoAction, result: UndoResult): UndoExecution {
  return result.ok
    ? { completed: action, remaining: null, error: null }
    : { completed: null, remaining: action, error: result.error };
}

function batchAction(actions: (UndoAction | null)[], label: string): UndoAction | null {
  const retained = actions.filter((action): action is UndoAction => action !== null);
  return retained.length ? { type: "batch", actions: retained, label } : null;
}

async function execute(action: UndoAction, api: UndoApiDeps, direction: Direction): Promise<UndoExecution> {
  // Batch execution stops on failure, but retains the exact completed subset
  // in original command order so the opposite direction remains composable.
  if (action.type === "batch") {
    const completed: (UndoAction | null)[] = action.actions.map(() => null);
    const remaining: (UndoAction | null)[] = [...action.actions];
    const indices = action.actions.map((_, index) => index);
    if (direction === "undo") indices.reverse();
    let error: string | null = null;
    for (const index of indices) {
      const result = await execute(action.actions[index], api, direction);
      completed[index] = result.completed;
      remaining[index] = result.remaining;
      if (result.error) {
        error = result.error;
        break;
      }
    }
    return { completed: batchAction(completed, action.label), remaining: batchAction(remaining, action.label), error };
  }

  try {
    switch (action.type) {
      case "rename": {
        const path = direction === "undo" ? action.path : joinPath(parentDir(action.path), action.oldName);
        return settled(action, await api.renameEntry(path, direction === "undo" ? action.oldName : action.newName));
      }
      case "move": {
        const originalDir = parentDir(action.sourcePath);
        const path = direction === "undo" ? action.destPath : joinPath(originalDir, basename(action.destPath));
        return settled(action, await api.moveEntry(path, direction === "undo" ? originalDir : parentDir(action.destPath)));
      }
      case "copy": {
        if (direction === "undo") return settled(action, await api.deleteEntry(action.copiedPath));
        const result = await api.restoreFromTrash([action.copiedPath]);
        if (!result.ok) return settled(action, result);
        return result.data.succeeded.includes(action.copiedPath)
          ? settled(action, { ok: true })
          : settled(action, { ok: false, error: fileBatchError(result.data) ?? "File was not restored" });
      }
      case "delete": {
        const result = await (direction === "undo" ? api.restoreFromTrash : api.deleteMultipleEntries)(action.paths);
        if (!result.ok) return settled(action, result);
        const succeeded = new Set(result.data.succeeded);
        const completedPaths = action.paths.filter((path) => succeeded.has(path));
        const remainingPaths = action.paths.filter((path) => !succeeded.has(path));
        return {
          completed: completedPaths.length ? { ...action, paths: completedPaths } : null,
          remaining: remainingPaths.length ? { ...action, paths: remainingPaths } : null,
          error: fileBatchError(result.data) ?? (remainingPaths.length ? "Some files were not processed" : null),
        };
      }
    }
  } catch (error) {
    return settled(action, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export const executeUndo = (action: UndoAction, api: UndoApiDeps): Promise<UndoExecution> => execute(action, api, "undo");
export const executeRedo = (action: UndoAction, api: UndoApiDeps): Promise<UndoExecution> => execute(action, api, "redo");
