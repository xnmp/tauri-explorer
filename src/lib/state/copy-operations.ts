/** Shared presentation for native copy sessions invoked by paste and drop. */
import { copyEntries } from "$lib/api/copy-session";
import type { FileEntry } from "$lib/domain/file";
import { basename, parentDir } from "$lib/domain/path";
import { copySessionError } from "$lib/domain/copy-session";
import { conflictResolver } from "./conflict-resolver.svelte";
import { operationsManager } from "./operations.svelte";
import { toastStore } from "./toast.svelte";
import { broadcastFileChange } from "./file-events";
import { frecencyStore } from "./frecency.svelte";

export interface CopyContext {
  onRefresh: () => unknown;
  onEntriesAdded?: (entries: FileEntry[]) => void;
  broadcastToOtherWindows?: boolean;
}

export async function copyFiles(
  sources: readonly string[], destination: string, context: CopyContext,
): Promise<string | null> {
  if (!sources.length) return null;
  const label = sources.length === 1 ? basename(sources[0]) : `${sources.length} items`;
  const operation = operationsManager.startOperation("copy", label, destination);
  const cancellation = new AbortController();
  const deliveredEntries = new Set<string>();
  const unsubscribe = operationsManager.subscribeCancellation(operation.id, () => cancellation.abort());
  try {
    const result = await copyEntries(sources, destination, {
      signal: cancellation.signal,
      jobId: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      shared: context.broadcastToOtherWindows,
      onConflict: (conflict, signal) => conflictResolver.prompt(conflict, signal),
      onEvent: (event) => {
        if (event.type === "completed") {
          if (event.entry && context.onEntriesAdded) {
            context.onEntriesAdded([event.entry]);
            deliveredEntries.add(event.entry.path);
          }
          operationsManager.updateProgress(operation.id, (event.item + 1) / event.total * 100);
        } else if (event.type === "progress") {
          const { bytesDone, bytesTotal } = event.progress;
          const fraction = bytesTotal > 0 ? Math.min(1, bytesDone / bytesTotal) : 0;
          operationsManager.updateProgress(operation.id, (event.item + fraction) / sources.length * 100,
            bytesDone, bytesTotal > 0 ? bytesTotal : undefined);
        }
      },
    });
    if (!result.ok) {
      operationsManager.failOperation(operation.id, result.error);
      toastStore.error(result.error);
      if (context.broadcastToOtherWindows) toastStore.broadcast(result.error, "error");
      return result.error;
    }
    const committed = result.data.items.flatMap((item) => item.status === "succeeded" ? [item.receipt] : []);
    const error = copySessionError(sources, result.data);
    if (committed.length) {
      const entries = committed.flatMap((receipt) => receipt.entry && !deliveredEntries.has(receipt.entry.path) ? [receipt.entry] : []);
      if (entries.length) context.onEntriesAdded?.(entries);
      broadcastFileChange([...new Set([destination, ...committed.map((receipt) => parentDir(receipt.path))])]);
      frecencyStore.pruneNonExistent();
    }
    if (error) operationsManager.failOperation(operation.id, error);
    else if (result.data.cancelled || cancellation.signal.aborted) operationsManager.cancelOperation(operation.id);
    else operationsManager.completeOperation(operation.id);

    const warnings = [...result.data.warnings, ...(result.warning ? [result.warning] : [])];
    const message = error ?? (committed.length && !result.data.cancelled && !cancellation.signal.aborted
      ? `Copied ${committed.length} item${committed.length === 1 ? "" : "s"} to ${basename(destination)}` : null);
    if (message) {
      if (error) toastStore.error(message); else toastStore.show(message, "info");
      if (context.broadcastToOtherWindows) toastStore.broadcast(message, error ? "error" : "info");
    }
    if (warnings.length) {
      const warning = warnings.join("\n");
      toastStore.error(warning);
      if (context.broadcastToOtherWindows) toastStore.broadcast(warning, "error");
    }
    return error;
  } finally {
    unsubscribe();
    // Refresh even when IPC failed: native settlement may have committed a
    // prefix which the renderer did not receive. History remains native-owned.
    await context.onRefresh();
  }
}
