/**
 * Shared file transfer logic used by both drag-drop and paste operations.
 * Issue: #107
 *
 * Consolidates conflict detection, conflict resolution, move/copy dispatch,
 * undo recording, toast notifications, broadcastFileChange, and frecency cleanup.
 */

import { moveEntry, copyEntry, fetchDirectory } from "$lib/api/files";
import type { ApiResult } from "$lib/api/files";
import { conflictResolver } from "./conflict-resolver.svelte";
import { undoStore } from "./undo.svelte";
import { toastStore } from "./toast.svelte";
import { broadcastFileChange } from "./file-events";
import { parentDir, basename, sameDirectory } from "$lib/domain/path";
import { frecencyStore } from "./frecency.svelte";
import type { FileEntry } from "$lib/domain/file";

export interface FileTransferOptions {
  onRefresh: () => void;
  overwrite?: boolean;
  skipConflictCheck?: boolean;
  /** Full entries for conflict detection (provides size/modified for conflict dialog) */
  existingEntries?: FileEntry[];
  /** Lightweight alternative: just names for conflict detection (no size/modified in dialog) */
  existingNames?: Set<string>;
  suppressToast?: boolean;
  suppressUndo?: boolean;
  suppressBroadcast?: boolean;
  suppressRefresh?: boolean;
  /** Broadcast undo action and toast to other windows (for cross-window DnD). */
  broadcastToOtherWindows?: boolean;
}

export interface FileTransferResult {
  ok: boolean;
  error?: string;
  /** The resulting FileEntry from the backend, available on success. */
  entry?: FileEntry;
}

/**
 * Transfer a single file: detect conflicts, resolve them, execute move/copy,
 * and optionally record undo, show toast, broadcast changes, and refresh.
 *
 * Callers that manage batches (paste) use suppress flags to handle those
 * concerns externally. Single-file callers (drop) let this function handle
 * everything.
 */
export async function performFileTransfer(
  sourcePath: string,
  targetDir: string,
  isCopy: boolean,
  options: FileTransferOptions,
): Promise<FileTransferResult> {
  const {
    onRefresh,
    overwrite: forceOverwrite = false,
    skipConflictCheck = false,
    existingEntries,
    existingNames,
    suppressToast = false,
    suppressUndo = false,
    suppressBroadcast = false,
    suppressRefresh = false,
    broadcastToOtherWindows = false,
  } = options;

  const fileName = basename(sourcePath);
  const sourceDir = parentDir(sourcePath);
  const isSameParent = sameDirectory(sourceDir, targetDir);

  // --- Central same-parent guard ---
  // MOVE into the entry's own parent is a no-op: skip instead of prompting a
  // bogus self-conflict (overwriting a file with itself is a data-loss path;
  // the backend also rejects source == target).
  if (isSameParent && !isCopy) {
    return { ok: false, error: "skipped" };
  }
  // COPY into the same parent never overwrites: force overwrite off so the
  // backend generates a "name - Copy" style name, exactly like paste does.
  let overwrite = isSameParent ? false : forceOverwrite;

  // --- Conflict detection & resolution ---
  // Same-parent copies skip the conflict dialog: the only "conflict" is the
  // source itself, and copy-name generation already avoids it.
  if (!skipConflictCheck && !overwrite && !isSameParent) {
    let conflictDetected = false;
    let destEntry: FileEntry | undefined;

    if (existingEntries) {
      const existing = existingEntries.find((e) => e.name === fileName);
      if (existing) {
        conflictDetected = true;
        destEntry = existing;
      }
    } else if (existingNames) {
      conflictDetected = existingNames.has(fileName);
    } else {
      // Fetch target directory to check for conflicts
      const dirResult = await fetchDirectory(targetDir);
      if (dirResult.ok) {
        const existing = dirResult.data.entries.find((e) => e.name === fileName);
        if (existing) {
          conflictDetected = true;
          destEntry = existing;
        }
      }
    }

    if (conflictDetected) {
      const { choice } = await conflictResolver.prompt({
        fileName,
        sourcePath,
        remaining: 0,
        destSize: destEntry?.size,
        destModified: destEntry?.modified,
      });
      if (choice === "skip" || choice === "cancel") {
        return { ok: false, error: "skipped" };
      }
      if (choice === "overwrite") overwrite = true;
    }
  }

  // --- Execute move or copy ---
  const result: ApiResult<FileEntry> = isCopy
    ? await copyEntry(sourcePath, targetDir, overwrite)
    : await moveEntry(sourcePath, targetDir, overwrite);

  if (!result.ok) {
    const verb = isCopy ? "copy" : "move";
    console.error(`Failed to ${verb}:`, result.error);
    if (!suppressToast) {
      toastStore.error(result.error);
    }
    return { ok: false, error: result.error };
  }

  // --- Post-transfer side effects ---
  const targetName = basename(targetDir);

  if (!suppressUndo) {
    const action = isCopy
      ? {
          type: "copy" as const,
          copiedPath: result.data.path,
          parentDir: targetDir,
        }
      : {
          type: "move" as const,
          sourcePath,
          destPath: result.data.path,
          originalDir: sourceDir,
        };
    if (broadcastToOtherWindows) {
      undoStore.pushAndBroadcast(action);
    } else {
      undoStore.push(action);
    }
  }

  if (!suppressToast) {
    const verb = isCopy ? "Copied" : "Moved";
    const message = `${verb} ${fileName} to ${targetName}`;
    toastStore.show(message, "info");
    if (broadcastToOtherWindows) {
      toastStore.broadcast(message, "info");
    }
  }

  if (!suppressRefresh) {
    onRefresh();
  }

  if (!suppressBroadcast) {
    broadcastFileChange([sourceDir, targetDir]);
    frecencyStore.pruneNonExistent();
  }

  return { ok: true, entry: result.data };
}
