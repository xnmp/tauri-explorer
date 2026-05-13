/**
 * Paste operation logic with conflict resolution and progress tracking.
 * Extracted from explorer.svelte.ts.
 *
 * Delegates per-file transfer to performFileTransfer (file-transfer.ts)
 * while managing batch concerns: conflict "apply to all", progress tracking,
 * batch undo, and aggregate toast/broadcast.
 */

import { estimateSize } from "$lib/api/files";
import { operationsManager } from "./operations.svelte";
import { conflictResolver, type ConflictChoice } from "./conflict-resolver.svelte";
import { undoStore } from "./undo.svelte";
import { broadcastFileChange } from "./file-events";
import { parentDir } from "$lib/domain/path";
import { toastStore } from "./toast.svelte";
import { frecencyStore } from "./frecency.svelte";
import { performFileTransfer } from "./file-transfer";
import type { FileEntry } from "$lib/domain/file";

export interface PasteSource {
  path: string;
  name: string;
  size?: number;
  modified?: string;
}

export interface PasteContext {
  destPath: string;
  existingEntries: FileEntry[];
  onEntriesAdded: (entries: FileEntry[]) => void;
  onRefresh: () => Promise<unknown>;
}

export interface PasteResult {
  error: string | null;
  timestamp: number;
}

export async function pasteEntries(
  sources: PasteSource[],
  isCut: boolean,
  context: PasteContext,
  onComplete?: () => void,
): Promise<string | null> {
  const { destPath, existingEntries, onEntriesAdded, onRefresh } = context;
  const opType = isCut ? "move" as const : "copy" as const;
  const label = sources.length === 1 ? sources[0].name : `${sources.length} items`;

  // Estimate total size for byte-level progress
  const sizeResult = await estimateSize(sources.map((s) => s.path));
  const totalBytes = sizeResult.ok ? sizeResult.data.totalBytes : 0;

  // Start tracking operation in progress dialog
  const op = operationsManager.startOperation(opType, label, destPath);

  const errors: string[] = [];
  const newEntries: FileEntry[] = [];
  const undoActions: import("./types").UndoAction[] = [];
  let bytesProcessed = 0;
  let cancelledByUser = false;

  // Detect conflicts: which source names already exist in destination
  const existingNames = new Set(existingEntries.map((e) => e.name));
  let globalChoice: ConflictChoice | null = null;

  for (let i = 0; i < sources.length; i++) {
    if (operationsManager.isOperationCancelled(op.id)) break;

    const source = sources[i];
    const sourceDir = parentDir(source.path);
    const isSameDir = sourceDir === destPath;

    // Copy to same dir: Rust auto-generates "name - Copy" suffix, no conflict dialog needed.
    // Cut to same dir: no-op (file is already there).
    const hasConflict = !isSameDir && existingNames.has(source.name);
    let overwrite = false;

    if (hasConflict) {
      if (globalChoice === "skip") continue;
      if (globalChoice === "cancel") { cancelledByUser = true; break; }
      if (globalChoice === "overwrite") {
        overwrite = true;
      } else {
        const remaining = sources.length - i - 1;
        const destEntry = existingEntries.find((e) => e.name === source.name);
        const { choice, applyToAll } = await conflictResolver.prompt({
          fileName: source.name,
          sourcePath: source.path,
          remaining,
          sourceSize: source.size,
          sourceModified: source.modified,
          destSize: destEntry?.size,
          destModified: destEntry?.modified,
        });
        if (applyToAll) globalChoice = choice;
        if (choice === "skip") continue;
        if (choice === "cancel") { cancelledByUser = true; break; }
        if (choice === "overwrite") overwrite = true;
      }
    }

    // Skip no-op: cut-paste to same directory (file is already there)
    if (isSameDir && isCut) {
      const existing = existingEntries.find((e) => e.name === source.name);
      if (existing) newEntries.push(existing);
    } else {
      // Delegate the actual transfer to shared logic.
      // Paste manages batch undo/toast/broadcast/refresh itself.
      const result = await performFileTransfer(source.path, destPath, !isCut, {
        onRefresh: () => {},
        overwrite,
        skipConflictCheck: true,
        suppressToast: true,
        suppressUndo: true,
        suppressBroadcast: true,
        suppressRefresh: true,
      });

      if (result.ok && result.entry) {
        newEntries.push(result.entry);
        if (isCut) {
          undoActions.push({
            type: "move",
            sourcePath: source.path,
            destPath: result.entry.path,
            originalDir: sourceDir,
          });
        } else {
          undoActions.push({
            type: "copy",
            copiedPath: result.entry.path,
            parentDir: destPath,
          });
        }
      } else if (!result.ok && result.error && result.error !== "skipped") {
        errors.push(`${source.name}: ${result.error}`);
      }
    }

    // Update progress (file-level granularity)
    if (totalBytes > 0) {
      bytesProcessed = Math.round(totalBytes * ((i + 1) / sources.length));
      operationsManager.updateProgress(
        op.id,
        ((i + 1) / sources.length) * 100,
        bytesProcessed,
        totalBytes,
      );
    } else {
      operationsManager.updateProgress(op.id, ((i + 1) / sources.length) * 100);
    }
  }

  // Push undo action(s) — batch if multiple files
  if (undoActions.length === 1) {
    undoStore.push(undoActions[0]);
  } else if (undoActions.length > 1) {
    undoStore.push({
      type: "batch",
      actions: undoActions,
      label: `${isCut ? "Moved" : "Copied"} ${undoActions.length} items`,
    });
  }

  onComplete?.();

  // Finalize operation tracking
  if (operationsManager.isOperationCancelled(op.id) || cancelledByUser) {
    operationsManager.cancelOperation(op.id);
  } else if (errors.length > 0 && newEntries.length === 0) {
    operationsManager.failOperation(op.id, errors.join("; "));
  } else {
    operationsManager.completeOperation(op.id);
  }

  if (newEntries.length > 0) {
    onEntriesAdded(newEntries);
    const affectedDirs = new Set([destPath]);
    for (const source of sources) {
      const dir = parentDir(source.path);
      affectedDirs.add(dir);
    }
    broadcastFileChange([...affectedDirs]);
    frecencyStore.pruneNonExistent();
  }

  await onRefresh();
  const error = errors.length > 0 ? `Failed: ${errors.join(", ")}` : null;
  if (error) {
    toastStore.error(error);
  } else if (!operationsManager.isOperationCancelled(op.id)) {
    toastStore.success("Pasted successfully");
  }
  return error;
}
