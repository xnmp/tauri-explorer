/**
 * Shared presentation for ordered native move sessions, used by cut/paste and
 * by drag-and-drop.
 *
 * The renderer never records an inverse for a session item. Native history
 * already holds one entry for the whole session, and a durable move's inverse
 * is its recovery record — replaying a path-only move can relocate whatever
 * now sits at the destination, which for a cross-filesystem move is the last
 * copy of the data.
 */
import { moveEntries } from "$lib/api/move-session";
import type { FileEntry } from "$lib/domain/file";
import { basename, parentDir } from "$lib/domain/path";
import { moveSessionError } from "$lib/domain/copy-session";
import { conflictResolver } from "./conflict-resolver.svelte";
import { operationsManager } from "./operations.svelte";
import { toastStore } from "./toast.svelte";
import { broadcastFileChange } from "./file-events";
import { frecencyStore } from "./frecency.svelte";

export interface MoveContext {
  onRefresh: () => unknown;
  onEntriesAdded?: (entries: FileEntry[]) => void;
  broadcastToOtherWindows?: boolean;
}

export interface MoveResult {
  /** Presentable failure text, or null when everything requested committed. */
  error: string | null;
  /** True only when every requested item reached the destination. */
  complete: boolean;
}

export async function moveFiles(
  sources: readonly string[], destination: string, context: MoveContext,
): Promise<MoveResult> {
  if (!sources.length) return { error: null, complete: true };
  const label = sources.length === 1 ? basename(sources[0]) : `${sources.length} items`;
  const operation = operationsManager.startOperation("move", label, destination);
  const cancellation = new AbortController();
  const deliveredEntries = new Set<string>();
  const unsubscribe = operationsManager.subscribeCancellation(operation.id, () => cancellation.abort());
  try {
    const result = await moveEntries(sources, destination, {
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
      return { error: result.error, complete: false };
    }
    const committed = result.data.items.flatMap((item) => item.status === "succeeded" ? [item.receipt] : []);
    const error = moveSessionError(sources, result.data);
    const cancelled = result.data.cancelled || cancellation.signal.aborted;
    if (committed.length) {
      const entries = committed.flatMap((receipt) => receipt.entry && !deliveredEntries.has(receipt.entry.path) ? [receipt.entry] : []);
      if (entries.length) context.onEntriesAdded?.(entries);
      // A relocation changes two directories per item: the vacated source
      // parent must refresh even though nothing landed there.
      broadcastFileChange([...new Set([
        destination,
        ...sources.map((source) => parentDir(source)),
        ...committed.map((receipt) => parentDir(receipt.path)),
      ])]);
      frecencyStore.pruneNonExistent();
    }
    if (error) operationsManager.failOperation(operation.id, error);
    else if (cancelled) operationsManager.cancelOperation(operation.id);
    else operationsManager.completeOperation(operation.id);

    const warnings = [...result.data.warnings, ...(result.warning ? [result.warning] : [])];
    const message = error ?? (committed.length && !cancelled
      ? `Moved ${committed.length} item${committed.length === 1 ? "" : "s"} to ${basename(destination)}` : null);
    if (message) {
      if (error) toastStore.error(message); else toastStore.show(message, "info");
      if (context.broadcastToOtherWindows) toastStore.broadcast(message, error ? "error" : "info");
    }
    if (warnings.length) {
      const warning = warnings.join("\n");
      toastStore.error(warning);
      if (context.broadcastToOtherWindows) toastStore.broadcast(warning, "error");
    }
    return { error, complete: !error && !cancelled && committed.length === sources.length };
  } finally {
    unsubscribe();
    // Refresh even when IPC failed: native settlement may have committed a
    // prefix which the renderer did not receive. History remains native-owned.
    await context.onRefresh();
  }
}
