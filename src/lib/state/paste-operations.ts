/**
 * Paste operation logic with conflict resolution and progress tracking.
 * Extracted from explorer.svelte.ts.
 */

import { moveEntry, copyEntry, estimateSize } from "$lib/api/files";
import { operationsManager } from "./operations.svelte";
import { conflictResolver, type ConflictChoice } from "./conflict-resolver.svelte";
import { undoStore } from "./undo.svelte";
import { broadcastFileChange } from "./file-events";
import { toastStore } from "./toast.svelte";
import type { FileEntry } from "$lib/domain/file";

export interface PasteSource {
  path: string;
  name: string;
}

export interface PasteContext {
  destPath: string;
  existingEntries: FileEntry[];
  onEntriesAdded: (entries: FileEntry[]) => void;
  onRefresh: () => Promise<void>;
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
  let bytesProcessed = 0;
  let cancelledByUser = false;

  // Detect conflicts: which source names already exist in destination
  const existingNames = new Set(existingEntries.map((e) => e.name));
  let globalChoice: ConflictChoice | null = null;

  for (let i = 0; i < sources.length; i++) {
    if (operationsManager.isOperationCancelled(op.id)) break;

    const source = sources[i];
    const sourceDir = source.path.substring(0, source.path.lastIndexOf("/")) || "/";

    // When cutting from the same directory, the file isn't a real conflict
    const isSameDir = isCut && sourceDir === destPath;
    const hasConflict = !isSameDir && existingNames.has(source.name);
    let overwrite = false;

    if (hasConflict) {
      if (globalChoice === "skip") continue;
      if (globalChoice === "cancel") { cancelledByUser = true; break; }
      if (globalChoice === "overwrite") {
        overwrite = true;
      } else {
        const remaining = sources.length - i - 1;
        const { choice, applyToAll } = await conflictResolver.prompt({
          fileName: source.name,
          sourcePath: source.path,
          remaining,
        });
        if (applyToAll) globalChoice = choice;
        if (choice === "skip") continue;
        if (choice === "cancel") { cancelledByUser = true; break; }
        if (choice === "overwrite") overwrite = true;
      }
    }

    // Skip no-op: cut-paste to same directory (file is already there)
    if (isSameDir) {
      const existing = existingEntries.find((e) => e.name === source.name);
      if (existing) newEntries.push(existing);
    } else {
      const result = isCut
        ? await moveEntry(source.path, destPath, overwrite)
        : await copyEntry(source.path, destPath, overwrite);

      if (result.ok) {
        newEntries.push(result.data);
        if (isCut) {
          undoStore.push({
            type: "move",
            sourcePath: source.path,
            destPath: result.data.path,
            originalDir: sourceDir,
          });
        }
      } else {
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
      const dir = source.path.substring(0, source.path.lastIndexOf("/")) || "/";
      affectedDirs.add(dir);
    }
    broadcastFileChange([...affectedDirs]);
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
