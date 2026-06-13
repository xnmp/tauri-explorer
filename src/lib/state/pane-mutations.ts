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
  renameEntry as apiRenameEntry,
  deleteEntry,
  deleteMultipleEntries,
  deleteEntryPermanent,
  extractArchive as apiExtractArchive,
  compressToZip as apiCompressToZip,
  cancelCompress as apiCancelCompress,
  createSymlink as apiCreateSymlink,
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

export interface PaneMutationContext {
  coreState: ExplorerCoreState;
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
      (dp) => current === dp || current.startsWith(dp + "/")
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
      coreState.selectedPaths = new Set([result.data.path]);
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
    const isPermanent = isPermanentArg ?? dialogStore.isPermanentDelete;

    const paths = entries.map((e) => e.path);
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
      coreState.selectedPaths = new Set(
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
    const name = path.split("/").filter(Boolean).pop() || path;
    const linkName = `${name} - Link`;
    const linkPath = `${coreState.currentPath}/${linkName}`;
    const result = await apiCreateSymlink(path, linkPath);
    if (result.ok) {
      coreState.entries = [...coreState.entries, result.data];
      ctx.markLocalMutation();
      broadcastFileChange([coreState.currentPath]);
    } else {
      toastStore.show(`Symlink failed: ${result.error}`, "error");
    }
  }

  async function extractArchive(path: string, here: boolean): Promise<void> {
    const result = await apiExtractArchive(path, here);
    if (result.ok) {
      ctx.markLocalMutation();
      ctx.refreshSilent();
      broadcastFileChange([coreState.currentPath]);
    } else {
      toastStore.show(`Extract failed: ${result.error}`, "error");
    }
  }

  async function compressToZip(paths: string[]): Promise<void> {
    // Client-generated job id keys progress events and backend cancellation.
    const jobId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const op = operationsManager.startOperation("compress", paths[0] ?? "");

    // Listen before invoking so fast jobs can't emit before we subscribe.
    // In browser/mock mode there is no event system — progress is skipped.
    let unlisten: (() => void) | null = null;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<ZipProgressEvent>("zip-progress", (event) => {
        const p = event.payload;
        if (p.jobId !== jobId) return;
        // The dialog's Cancel removes the operation; relay to the backend.
        if (operationsManager.isOperationCancelled(op.id)) {
          void apiCancelCompress(jobId);
          return;
        }
        const pct = p.bytesTotal > 0 ? (p.bytesDone / p.bytesTotal) * 100 : 0;
        operationsManager.updateProgress(op.id, pct, p.bytesDone, p.bytesTotal);
      });
    } catch {
      // Not running in Tauri — mock compress completes instantly.
    }

    const result = await apiCompressToZip(paths, jobId);
    unlisten?.();

    if (result.ok) {
      operationsManager.completeOperation(op.id);
      ctx.markLocalMutation();
      ctx.refreshSilent();
      broadcastFileChange([coreState.currentPath]);
    } else if (operationsManager.isOperationCancelled(op.id) || /cancelled/i.test(result.error)) {
      // User-initiated cancel: the backend removed the partial archive.
      operationsManager.clearOperation(op.id);
      toastStore.show("Compression cancelled", "info");
    } else {
      operationsManager.failOperation(op.id, result.error);
      toastStore.show(`Compress failed: ${result.error}`, "error");
    }
  }

  return {
    navigateAwayIfNeeded,
    createFolder,
    rename,
    confirmDelete,
    createSymlinkForEntry,
    extractArchive,
    compressToZip,
  };
}

export type PaneMutations = ReturnType<typeof createPaneMutations>;
