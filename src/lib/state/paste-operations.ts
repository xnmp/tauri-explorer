/**
 * Paste dispatch and cut-paste conflict/progress presentation.
 * Extracted from explorer.svelte.ts.
 *
 * Copies use the lazy native session; moves retain their ordered per-entry
 * path until native move-session integration.
 */

import { estimateSize } from "$lib/api/files";
import { operationsManager } from "./operations.svelte";
import { conflictResolver, type ConflictChoice } from "./conflict-resolver.svelte";
import { undoStore } from "./undo.svelte";
import { broadcastFileChange } from "./file-events";
import { basename, parentDir, sameDirectory } from "$lib/domain/path";
import { toastStore } from "./toast.svelte";
import { frecencyStore } from "./frecency.svelte";
import { performFileTransfer } from "./file-transfer";
import { fileMutationRecoveryMessage, type FileEntry } from "$lib/domain/file";

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
  if (!isCut) {
    const { copyFiles } = await import("./copy-operations");
    const result = await copyFiles(sources.map((source) => source.path), context.destPath, context);
    onComplete?.();
    return result;
  }
  const { destPath, existingEntries, onEntriesAdded, onRefresh } = context;
  const opType = "move" as const;
  const label = sources.length === 1 ? sources[0].name : `${sources.length} items`;

  // Byte totals power the progress bar, but the recursive size scan can take
  // seconds on big trees — it must not gate the transfer start (#388). Run it
  // alongside; progress falls back to file-count granularity until it lands.
  let totalBytes = 0;
  void estimateSize(sources.map((s) => s.path)).then((sizeResult) => {
    if (sizeResult.ok) totalBytes = sizeResult.data.totalBytes;
  });

  // Start tracking operation in progress dialog
  const op = operationsManager.startOperation(opType, label, destPath);

  const errors: string[] = [];
  const warnings: string[] = [];
  const newEntries: FileEntry[] = [];
  const undoActions: import("./types").UndoAction[] = [];
  const affectedDirs = new Set<string>();
  let committedCount = 0;
  let safelyCompletedCutCount = 0;
  let bytesProcessed = 0;
  let cancelledByUser = false;

  // Detect conflicts: which source names already exist in destination
  const existingNames = new Set(existingEntries.map((e) => e.name));
  let globalChoice: ConflictChoice | null = null;

  for (let i = 0; i < sources.length; i++) {
    if (operationsManager.isOperationCancelled(op.id)) break;

    const source = sources[i];
    const sourceDir = parentDir(source.path);
    const isSameDir = sameDirectory(sourceDir, destPath);

    // Cut to the same directory is a no-op.
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
    if (isSameDir) {
      const existing = existingEntries.find((e) => e.name === source.name);
      if (existing) newEntries.push(existing);
      safelyCompletedCutCount++;
    } else {
      // Delegate the actual transfer to shared logic.
      // Paste manages batch undo/toast/broadcast/refresh itself.
      const result = await performFileTransfer(source.path, destPath, false, {
        onRefresh: () => {},
        overwrite,
        skipConflictCheck: true,
        suppressToast: true,
        suppressUndo: true,
        suppressBroadcast: true,
        suppressRefresh: true,
      });

      if (result.ok) {
        committedCount++;
        affectedDirs.add(destPath);
        affectedDirs.add(sourceDir);
        if (result.entry) {
          newEntries.push(result.entry);
          // Each pasted entry appears in the listing the moment its transfer
          // finishes instead of after the whole batch (#388); onEntriesAdded
          // dedupes by path, so the final batch call below stays safe.
          onEntriesAdded([result.entry]);
        }
        // Track the pasted name so later sources in this batch with the same
        // name are detected as conflicts (the snapshot taken before the loop
        // doesn't know about entries created during the batch).
        existingNames.add(basename(result.path));
        if (result.warning) warnings.push(`${source.name}: ${result.warning}`);
        if (result.recovery) {
          errors.push(`${source.name}: ${fileMutationRecoveryMessage(result.recovery)}`);
        } else if (result.replacement) {
          safelyCompletedCutCount++;
        } else {
          safelyCompletedCutCount++;
          undoActions.push({
            type: "move",
            sourcePath: source.path,
            destPath: result.path,
            originalDir: sourceDir,
          });

        }
      } else if (!result.ok && result.reason === "cancelled") {
        cancelledByUser = true;
        break;
      } else if (!result.ok && result.reason === "failed") {
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
    await undoStore.push(undoActions[0]);
  } else if (undoActions.length > 1) {
    await undoStore.push({
      type: "batch",
      actions: undoActions,
      label: `Moved ${undoActions.length} items`,
    });
  }

  // The caller clears a cut clipboard on completion. Keep it intact when any
  // source failed, was skipped/cancelled, or needs recovery so the UI does not
  // claim that the whole cut completed.
  if (safelyCompletedCutCount === sources.length) onComplete?.();

  // The requested operation is incomplete even when some destination effects
  // committed. Keep that distinction in the progress dialog as well as the toast.
  const error = errors.length > 0
    ? `${committedCount > 0 ? "Paste incomplete" : "Paste failed"}: ${errors.join(", ")}`
    : null;
  if (error) {
    operationsManager.failOperation(op.id, error);
  } else if (operationsManager.isOperationCancelled(op.id) || cancelledByUser) {
    operationsManager.cancelOperation(op.id);
  } else {
    operationsManager.completeOperation(op.id);
  }

  if (committedCount > 0) {
    if (newEntries.length > 0) onEntriesAdded(newEntries);
    broadcastFileChange([...affectedDirs]);
    frecencyStore.pruneNonExistent();
  }

  // Toast before the confirming refresh (#388): the entries are already
  // visible optimistically, so feedback shouldn't wait on a re-list.
  if (error) {
    toastStore.error(error);
  } else if (!operationsManager.isOperationCancelled(op.id)) {
    toastStore.success("Pasted successfully");
  }
  if (warnings.length > 0) toastStore.error(warnings.join("\n"));
  await onRefresh();
  return error;
}
