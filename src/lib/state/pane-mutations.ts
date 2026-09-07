/**
 * Per-pane file mutations: create / rename / delete / symlink / archive.
 * Extracted from explorer.svelte.ts.
 *
 * Filesystem success publishes durable effects independently of the initiating
 * pane. View updates borrow that pane's navigation/lifetime, and dialog closes
 * borrow the exact editor opening that admitted the operation.
 */

import { createDirectory, createEmptyFile, renameEntry as apiRenameEntry, deleteEntry, deleteMultipleEntries, deleteEntryPermanent, createSymlink as apiCreateSymlink } from "$lib/api/files";
import { extractArchive as apiExtractArchive, compressToZip as apiCompressToZip, cancelCompress as apiCancelCompress, cancelExtract as apiCancelExtract, type ZipProgressEvent } from "$lib/api/archive";
import { type ApiResult } from "$lib/api/common";
import { operationsManager } from "./operations.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { ExplorerCoreState, UndoAction } from "./types";
import { broadcastFileChange } from "./file-events";
import { clipboardStore } from "./clipboard.svelte";
import { dialogStore } from "./dialogs.svelte";
import { undoStore } from "./undo.svelte";
import { frecencyStore } from "./frecency.svelte";
import { toastStore } from "./toast.svelte";
import { renameThumbnailCache } from "$lib/state/thumbnail-cache";
import { basename, joinPath, isInsideDir, isUncPath, parentDir } from "$lib/domain/path";

export interface PaneMutationContext {
  coreState: ExplorerCoreState;
  /** Replace the selection via the store's in-place SvelteSet mutation —
   *  never reassign `coreState.selectedPaths` (kills granular reactivity). */
  setSelection: (next: Iterable<string>) => void;
  capture: () => { path: string; current: () => boolean; selectionCurrent: () => boolean };
  alive: () => boolean;
  navigateTo: (path: string) => Promise<unknown>;
  refreshSilent: () => void;
}

export function createPaneMutations(ctx: PaneMutationContext) {
  const { coreState } = ctx;

  /** Leave the current directory if it was (inside) one of `deletedPaths`. */
  async function navigateAwayIfNeeded(deletedPaths: Set<string>): Promise<void> {
    if (!ctx.alive()) return;
    let destination = coreState.currentPath;
    while ([...deletedPaths].some((path) => isInsideDir(destination, path))) {
      const parent = parentDir(destination);
      if (parent === destination || !parent) return;
      destination = parent;
    }
    if (destination !== coreState.currentPath) await ctx.navigateTo(destination);
  }

  async function createEntry(
    name: string,
    create: (path: string, name: string) => Promise<ApiResult<FileEntry>>,
  ): Promise<string | null> {
    const origin = ctx.capture();
    if (!origin.current()) return "Pane is closed";
    if (!origin.path) return "No current directory";
    const result = await create(origin.path, name);
    if (!result.ok) return result.error;

    if (origin.current()) {
      // The watcher may have observed the new entry before the IPC reply.
      coreState.entries = [...coreState.entries.filter((entry) => entry.path !== result.data.path), result.data];
      if (origin.selectionCurrent()) {
        ctx.setSelection([result.data.path]);
        coreState.selectionAnchorPath = result.data.path;
        coreState.cursorPath = result.data.path;
      }
    }
    broadcastFileChange([parentDir(result.data.path)]);
    return null;
  }

  const createFolder = (name: string) => createEntry(name, createDirectory);
  const createFile = (name: string) => createEntry(name, createEmptyFile);

  async function rename(newName: string): Promise<string | null> {
    const origin = ctx.capture();
    if (!origin.current()) return "Pane is closed";
    const session = dialogStore.fileOperationSession;
    const renamingEntry = dialogStore.renamingEntry;
    if (!renamingEntry) return "No entry selected for rename";

    const oldName = renamingEntry.name;
    const oldPath = renamingEntry.path;
    const result = await apiRenameEntry(oldPath, newName);

    if (result.ok) {
      undoStore.push({ type: "rename", path: result.data.path, oldName, newName });
      renameThumbnailCache(oldPath, result.data.path);
      if (origin.current()) {
        coreState.entries = coreState.entries.map((e) => (e.path === oldPath ? result.data : e));
        // Preserve identity through a rename without restoring selection or focus
        // that the user changed while the filesystem operation was pending.
        if (coreState.selectedPaths.has(oldPath)) {
          ctx.setSelection([...coreState.selectedPaths].map((path) => path === oldPath ? result.data.path : path));
        }
        if (coreState.selectionAnchorPath === oldPath) coreState.selectionAnchorPath = result.data.path;
        if (coreState.cursorPath === oldPath) coreState.cursorPath = result.data.path;
      }
      clipboardStore.updatePath(oldPath, result.data);
      dialogStore.cancelRename(session);
      broadcastFileChange([...new Set([parentDir(oldPath), parentDir(result.data.path)])]);
      frecencyStore.pruneNonExistent();
      return null;
    }
    return result.error;
  }

  async function confirmDelete(
    entriesArg?: readonly FileEntry[],
    isPermanentArg?: boolean,
  ): Promise<string | null> {
    const origin = ctx.capture();
    if (!origin.current()) return "Pane is closed";
    // Direct actions (including Miller columns) do not own the global dialog.
    const session = entriesArg === undefined ? dialogStore.fileOperationSession : null;
    const entries = entriesArg ?? dialogStore.deletingEntries;
    if (entries.length === 0) return "No entries selected for delete";
    const requestedPermanent = isPermanentArg ?? dialogStore.isPermanentDelete;

    const paths = entries.map((e) => e.path);
    // UNC/WSL locations have no Recycle Bin — such deletes are always permanent
    // (the backend removes them directly). Treat them as permanent here too, so
    // we don't record a "restore from trash" undo that could never succeed.
    const isPermanent = requestedPermanent || paths.some(isUncPath);

    let result: { ok: boolean; error?: string };
    const removed: string[] = [];

    if (isPermanent) {
      const errors: string[] = [];
      for (const path of paths) {
        const r = await deleteEntryPermanent(path);
        if (!r.ok) errors.push(r.error);
        else removed.push(path);
      }
      result = errors.length > 0 ? { ok: false, error: errors.join("; ") } : { ok: true };
    } else {
      result = entries.length === 1
        ? await deleteEntry(paths[0])
        : await deleteMultipleEntries(paths);
      if (result.ok) removed.push(...paths);
    }

    if (removed.length > 0) {
      if (!isPermanent) {
        const groups = new Map<string, string[]>();
        for (const path of paths) {
          const parent = parentDir(path);
          const group = groups.get(parent);
          if (group) group.push(path);
          else groups.set(parent, [path]);
        }
        const actions: UndoAction[] = [...groups].map(([parentDir, paths]) => ({ type: "delete", paths, parentDir }));
        undoStore.push(actions.length === 1 ? actions[0] : { type: "batch", actions, label: "Delete" });
      }
      const deletedPaths = new Set(removed);
      if (origin.current()) {
        coreState.entries = coreState.entries.filter((e) => !deletedPaths.has(e.path));
        ctx.setSelection(
          [...coreState.selectedPaths].filter((p) => !deletedPaths.has(p))
        );
      }
      if (result.ok) dialogStore.cancelDelete(session);
      broadcastFileChange([...new Set(removed.map(parentDir))]);
      await navigateAwayIfNeeded(deletedPaths);
      frecencyStore.pruneNonExistent();
    }
    return result.ok ? null : result.error ?? "Unknown error";
  }

  async function createSymlinkForEntry(path: string): Promise<void> {
    const origin = ctx.capture();
    if (!origin.current() || !origin.path) return;
    const name = basename(path);
    const linkName = `${name} - Link`;
    const linkPath = joinPath(origin.path, linkName);
    const result = await apiCreateSymlink(path, linkPath);
    if (result.ok) {
      if (origin.current()) {
        coreState.entries = [...coreState.entries.filter((entry) => entry.path !== result.data.path), result.data];
      }
      broadcastFileChange([parentDir(result.data.path)]);
    } else {
      toastStore.show(`Symlink failed: ${result.error}`, "error");
    }
  }

  /**
   * Run a long archive operation (compress/extract) with the shared progress
   * dialog: listen for byte-progress events before invoking (so fast jobs
   * can't emit first), relay a dialog Cancel to the backend, and settle the
   * operation. Returns the actual output path on success.
   */
  async function runArchiveJob(opts: {
    type: "compress" | "extract";
    label: string;
    event: "zip-progress" | "unzip-progress";
    cancelledToast: string;
    failPrefix: string;
    invoke: (jobId: number) => Promise<ApiResult<string>>;
    cancel: (jobId: number) => Promise<void>;
  }): Promise<string | null> {
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

    let result: ApiResult<string>;
    try {
      result = await opts.invoke(jobId);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      unlisten?.();
    }

    if (result.ok) {
      operationsManager.completeOperation(op.id);
      return result.data;
    }
    if (operationsManager.isOperationCancelled(op.id) || /cancelled/i.test(result.error)) {
      // User-initiated cancel: the backend removed the partial output.
      operationsManager.clearOperation(op.id);
      toastStore.show(opts.cancelledToast, "info");
    } else {
      operationsManager.failOperation(op.id, result.error);
      toastStore.show(`${opts.failPrefix}: ${result.error}`, "error");
    }
    return null;
  }

  async function extractArchive(path: string, here: boolean): Promise<void> {
    const origin = ctx.capture();
    if (!origin.current()) return;
    const output = await runArchiveJob({
      type: "extract",
      label: path,
      event: "unzip-progress",
      cancelledToast: "Extraction cancelled",
      failPrefix: "Extract failed",
      invoke: (jobId) => apiExtractArchive(path, here, jobId),
      cancel: apiCancelExtract,
    });
    if (output !== null) {
      if (origin.current()) ctx.refreshSilent();
      broadcastFileChange([...new Set([parentDir(path), output])]);
    }
  }

  async function compressToZip(paths: string[]): Promise<void> {
    const origin = ctx.capture();
    if (!origin.current()) return;
    const output = await runArchiveJob({
      type: "compress",
      label: paths[0] ?? "",
      event: "zip-progress",
      cancelledToast: "Compression cancelled",
      failPrefix: "Compress failed",
      invoke: (jobId) => apiCompressToZip(paths, jobId),
      cancel: apiCancelCompress,
    });
    if (output !== null) {
      if (origin.current()) ctx.refreshSilent();
      broadcastFileChange([parentDir(output)]);
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
