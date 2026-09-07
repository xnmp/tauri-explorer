/**
 * Paste operation logic with conflict resolution and progress tracking.
 * Extracted from explorer.svelte.ts.
 *
 * Delegates per-file transfer to performFileTransfer (file-transfer.ts)
 * while managing batch concerns: conflict "apply to all", progress tracking,
 * batch undo, and aggregate toast/broadcast.
 */

import { estimateSize, cancelCopy } from "$lib/api/files";
import { type ZipProgressEvent } from "$lib/api/archive";
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
  const { destPath, existingEntries, onEntriesAdded, onRefresh } = context;
  const opType = isCut ? "move" as const : "copy" as const;
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
  const newEntries: FileEntry[] = [];
  const undoActions: import("./types").UndoAction[] = [];
  const affectedDirs = new Set<string>();
  let committedCount = 0;
  let safelyCompletedCutCount = 0;
  let bytesProcessed = 0;
  let cancelledByUser = false;

  // Byte-level progress for the file currently transferring. The backend emits
  // `copy-progress` for the active copy keyed by `currentJobId`; we blend its
  // intra-file fraction with the file index so one huge file no longer sits at
  // 0% until it finishes. A dialog Cancel is relayed to the backend so a copy
  // can be aborted mid-file, not just between files.
  let currentIndex = 0;
  let currentJobId = 0;
  let unlistenCopyProgress: (() => void) | null = null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlistenCopyProgress = await listen<ZipProgressEvent>("copy-progress", (event) => {
      const p = event.payload;
      if (p.jobId !== currentJobId) return;
      if (operationsManager.isOperationCancelled(op.id)) {
        void cancelCopy(currentJobId);
        return;
      }
      const intra = p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : 0;
      const fraction = (currentIndex + intra) / sources.length;
      operationsManager.updateProgress(
        op.id,
        fraction * 100,
        totalBytes > 0 ? Math.round(totalBytes * fraction) : undefined,
        totalBytes > 0 ? totalBytes : undefined,
      );
    });
  } catch {
    // Not running in Tauri (mock/browser) — copies complete without events.
  }

  // Detect conflicts: which source names already exist in destination
  const existingNames = new Set(existingEntries.map((e) => e.name));
  let globalChoice: ConflictChoice | null = null;

  for (let i = 0; i < sources.length; i++) {
    currentIndex = i;
    // Fresh job id per source so stale events from a prior file are ignored.
    currentJobId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    if (operationsManager.isOperationCancelled(op.id)) break;

    const source = sources[i];
    const sourceDir = parentDir(source.path);
    const isSameDir = sameDirectory(sourceDir, destPath);

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
      safelyCompletedCutCount++;
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
        jobId: currentJobId,
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
        if (result.recovery) {
          errors.push(`${source.name}: ${fileMutationRecoveryMessage(result.recovery)}`);
        } else if (isCut) {
          safelyCompletedCutCount++;
          undoActions.push({
            type: "move",
            sourcePath: source.path,
            destPath: result.path,
            originalDir: sourceDir,
          });
        } else {
          undoActions.push({
            type: "copy",
            copiedPath: result.path,
            parentDir: destPath,
          });
        }
      } else if (!result.ok && /cancelled/i.test(result.error ?? "")) {
        // Mid-file cancel relayed to the backend: stop the batch cleanly
        // rather than reporting it as a failure.
        cancelledByUser = true;
        break;
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

  unlistenCopyProgress?.();

  // Push undo action(s) — batch if multiple files
  if (undoActions.length === 1) {
    await undoStore.push(undoActions[0]);
  } else if (undoActions.length > 1) {
    await undoStore.push({
      type: "batch",
      actions: undoActions,
      label: `${isCut ? "Moved" : "Copied"} ${undoActions.length} items`,
    });
  }

  // The caller clears a cut clipboard on completion. Keep it intact when any
  // source failed, was skipped/cancelled, or needs recovery so the UI does not
  // claim that the whole cut completed.
  if (!isCut || safelyCompletedCutCount === sources.length) onComplete?.();

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
  await onRefresh();
  return error;
}
