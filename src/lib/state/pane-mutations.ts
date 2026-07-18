/**
 * Per-pane file mutations: create / rename / delete / symlink / archive.
 * Extracted from explorer.svelte.ts.
 *
 * Mutations update `coreState` in place (it is a $state proxy, so
 * reactivity is preserved) and mark the local-mutation cooldown so the
 * filesystem watcher's follow-up event doesn't re-fetch what we already
 * applied.
 */

import {
  createDirectory,
  createEmptyFile,
  renameEntry as apiRenameEntry,
  deleteEntry,
  deleteMultipleEntries,
  deleteEntryPermanent,
  extractArchive as apiExtractArchive,
  compressToZip as apiCompressToZip,
  cancelCompress as apiCancelCompress,
  cancelExtract as apiCancelExtract,
  createSymlink as apiCreateSymlink,
  type ApiResult,
  type ZipProgressEvent,
} from "$lib/api/files";
import { operationsManager } from "./operations.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { ExplorerCoreState } from "./types";
import { broadcastFileChange } from "./file-events";
import { clipboardStore } from "./clipboard.svelte";
import { dialogStore } from "./dialogs.svelte";
import { undoStore } from "./undo.svelte";
import { frecencyStore } from "./frecency.svelte";
import { toastStore } from "./toast.svelte";
import { renameThumbnailCache } from "$lib/state/thumbnail-cache";
import { basename, joinPath, isInsideDir, isUncPath } from "$lib/domain/path";

export interface PaneMutationContext {
  coreState: ExplorerCoreState;
  /** Replace the selection via the store's in-place SvelteSet mutation —
   *  never reassign `coreState.selectedPaths` (kills granular reactivity). */
  setSelection: (next: Iterable<string>) => void;
  displayEntries: () => FileEntry[];
  markLocalMutation: () => void;
  /** Parent of the current directory, or null at the root. */
  getParentPath: () => string | null;
  navigateTo: (path: string) => Promise<void>;
  refreshSilent: () => void;
}

export function createPaneMutations(ctx: PaneMutationContext) {
  const { coreState } = ctx;

  /** Leave the current directory if it was (inside) one of `deletedPaths`. */
  async function navigateAwayIfNeeded(deletedPaths: Set<string>): Promise<void> {
    const current = coreState.currentPath;
    const shouldNavigateAway = [...deletedPaths].some(
      (dp) => isInsideDir(current, dp)
    );
    if (shouldNavigateAway) {
      const parentPath = ctx.getParentPath();
      if (parentPath) await ctx.navigateTo(parentPath);
    }
  }

  async function createFolder(name: string): Promise<string | null> {
    if (!coreState.currentPath) return "No current directory";

    ctx.markLocalMutation();
    const result = await createDirectory(coreState.currentPath, name);

    if (result.ok) {
      coreState.entries = [...coreState.entries, result.data];
      ctx.setSelection([result.data.path]);
      const idx = ctx.displayEntries().findIndex((e) => e.path === result.data.path);
      coreState.selectionAnchorIndex = idx >= 0 ? idx : null;
      ctx.markLocalMutation();
      broadcastFileChange([coreState.currentPath]);
      return null;
    }
    return result.error;
  }

  async function createFile(name: string): Promise<string | null> {
    if (!coreState.currentPath) return "No current directory";

    ctx.markLocalMutation();
    const result = await createEmptyFile(coreState.currentPath, name);

    if (result.ok) {
      coreState.entries = [...coreState.entries, result.data];
      ctx.setSelection([result.data.path]);
      const idx = ctx.displayEntries().findIndex((e) => e.path === result.data.path);
      coreState.selectionAnchorIndex = idx >= 0 ? idx : null;
      ctx.markLocalMutation();
      broadcastFileChange([coreState.currentPath]);
      return null;
    }
    return result.error;
  }

  async function rename(newName: string): Promise<string | null> {
    const renamingEntry = dialogStore.renamingEntry;
    if (!renamingEntry) return "No entry selected for rename";

    const oldName = renamingEntry.name;
    const oldPath = renamingEntry.path;
    ctx.markLocalMutation();
    const result = await apiRenameEntry(oldPath, newName);

    if (result.ok) {
      undoStore.push({ type: "rename", path: result.data.path, oldName, newName });
      renameThumbnailCache(oldPath, result.data.path);
      coreState.entries = coreState.entries.map((e) => (e.path === oldPath ? result.data : e));
      clipboardStore.updatePath(oldPath, result.data);
      ctx.markLocalMutation();
      dialogStore.cancelRename();
      frecencyStore.pruneNonExistent();
      return null;
    }
    return result.error;
  }

  async function confirmDelete(
    entriesArg?: readonly FileEntry[],
    isPermanentArg?: boolean,
  ): Promise<string | null> {
    const entries = entriesArg ?? dialogStore.deletingEntries;
    if (entries.length === 0) return "No entries selected for delete";
    const requestedPermanent = isPermanentArg ?? dialogStore.isPermanentDelete;

    const paths = entries.map((e) => e.path);
    // UNC/WSL locations have no Recycle Bin — such deletes are always permanent
    // (the backend removes them directly). Treat them as permanent here too, so
    // we don't record a "restore from trash" undo that could never succeed.
    const isPermanent = requestedPermanent || paths.some(isUncPath);

    let result: { ok: boolean; error?: string };

    ctx.markLocalMutation();
    if (isPermanent) {
      const errors: string[] = [];
      for (const path of paths) {
        const r = await deleteEntryPermanent(path);
        if (!r.ok) errors.push(r.error);
      }
      result = errors.length > 0 ? { ok: false, error: errors.join("; ") } : { ok: true };
    } else {
      result = entries.length === 1
        ? await deleteEntry(paths[0])
        : await deleteMultipleEntries(paths);
    }

    if (result.ok) {
      if (!isPermanent) {
        undoStore.push({ type: "delete", paths, parentDir: coreState.currentPath });
      }
      const deletedPaths = new Set(paths);
      coreState.entries = coreState.entries.filter((e) => !deletedPaths.has(e.path));
      ctx.setSelection(
        [...coreState.selectedPaths].filter((p) => !deletedPaths.has(p))
      );
      ctx.markLocalMutation();
      dialogStore.cancelDelete();
      await navigateAwayIfNeeded(deletedPaths);
      frecencyStore.pruneNonExistent();
      return null;
    }
    return result.error ?? "Unknown error";
  }

  async function createSymlinkForEntry(path: string): Promise<void> {
    const name = basename(path);
    const linkName = `${name} - Link`;
    const linkPath = joinPath(coreState.currentPath, linkName);
    const result = await apiCreateSymlink(path, linkPath);
    if (result.ok) {
      coreState.entries = [...coreState.entries, result.data];
      ctx.markLocalMutation();
      broadcastFileChange([coreState.currentPath]);
    } else {
      toastStore.show(`Symlink failed: ${result.error}`, "error");
    }
  }

  /**
   * Run a long archive operation (compress/extract) with the shared progress
   * dialog: listen for byte-progress events before invoking (so fast jobs
   * can't emit first), relay a dialog Cancel to the backend, and settle the
   * operation. Returns true on success so the caller can refresh.
   */
  async function runArchiveJob(opts: {
    type: "compress" | "extract";
    label: string;
    event: "zip-progress" | "unzip-progress";
    cancelledToast: string;
    failPrefix: string;
    invoke: (jobId: number) => Promise<ApiResult<string>>;
    cancel: (jobId: number) => Promise<void>;
  }): Promise<boolean> {
    // Client-generated job id keys progress events and backend cancellation.
    const jobId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const op = operationsManager.startOperation(opts.type, opts.label);

    // In browser/mock mode there is no event system — progress is skipped.
    let unlisten: (() => void) | null = null;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<ZipProgressEvent>(opts.event, (event) => {
        const p = event.payload;
        if (p.jobId !== jobId) return;
        // The dialog's Cancel removes the operation; relay to the backend.
        if (operationsManager.isOperationCancelled(op.id)) {
          void opts.cancel(jobId);
          return;
        }
        const pct = p.bytesTotal > 0 ? (p.bytesDone / p.bytesTotal) * 100 : 0;
        operationsManager.updateProgress(op.id, pct, p.bytesDone, p.bytesTotal);
      });
    } catch {
      // Not running in Tauri — the mock completes instantly.
    }

    const result = await opts.invoke(jobId);
    unlisten?.();

    if (result.ok) {
      operationsManager.completeOperation(op.id);
      return true;
    }
    if (operationsManager.isOperationCancelled(op.id) || /cancelled/i.test(result.error)) {
      // User-initiated cancel: the backend removed the partial output.
      operationsManager.clearOperation(op.id);
      toastStore.show(opts.cancelledToast, "info");
    } else {
      operationsManager.failOperation(op.id, result.error);
      toastStore.show(`${opts.failPrefix}: ${result.error}`, "error");
    }
    return false;
  }

  async function extractArchive(path: string, here: boolean): Promise<void> {
    const ok = await runArchiveJob({
      type: "extract",
      label: path,
      event: "unzip-progress",
      cancelledToast: "Extraction cancelled",
      failPrefix: "Extract failed",
      invoke: (jobId) => apiExtractArchive(path, here, jobId),
      cancel: apiCancelExtract,
    });
    if (ok) {
      ctx.markLocalMutation();
      ctx.refreshSilent();
      broadcastFileChange([coreState.currentPath]);
    }
  }

  async function compressToZip(paths: string[]): Promise<void> {
    const ok = await runArchiveJob({
      type: "compress",
      label: paths[0] ?? "",
      event: "zip-progress",
      cancelledToast: "Compression cancelled",
      failPrefix: "Compress failed",
      invoke: (jobId) => apiCompressToZip(paths, jobId),
      cancel: apiCancelCompress,
    });
    if (ok) {
      ctx.markLocalMutation();
      ctx.refreshSilent();
      broadcastFileChange([coreState.currentPath]);
    }
  }

  return {
    navigateAwayIfNeeded,
    createFolder,
    createFile,
    rename,
    confirmDelete,
    createSymlinkForEntry,
    extractArchive,
    compressToZip,
  };
}

export type PaneMutations = ReturnType<typeof createPaneMutations>;
