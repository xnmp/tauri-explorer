/** IPC for the in-app Trash location (#863). */
import { invoke, extractError, type ApiResult } from "./common";
import { invokeFileMutation } from "./file-mutations";
import type { FileBatchOutcome } from "$lib/domain/file-batch-outcome";
import type { TrashWireListing } from "$lib/domain/trash";

/** Enumerate every readable trash source; unreadable ones arrive as issues. */
export async function listTrash(): Promise<ApiResult<TrashWireListing>> {
  try {
    return { ok: true, data: await invoke<TrashWireListing>("list_trash") };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Restore listed items by their opaque IDs; outcomes are keyed by original path. */
export function restoreTrashItems(ids: string[]): Promise<ApiResult<FileBatchOutcome>> {
  return invokeFileMutation<FileBatchOutcome>("restore_trash_items", { ids });
}
