/**
 * One presentation for both ordered native sessions.
 *
 * Copy and move differ only in which command runs, which directories the
 * vacated side adds to the broadcast, and the words in the toast. Keeping one
 * implementation is the point: a second hand-written loop would eventually
 * acquire a weaker cancellation, refresh or completion contract than this one
 * and nothing would notice — the same reason the Rust side has one session
 * engine with two `Work` implementations.
 */
import type { ApiResult } from "$lib/api/common";
import type { SessionOptions } from "$lib/api/copy-session";
import type { CopySessionOutcome } from "$lib/domain/copy-session";
import type { FileEntry } from "$lib/domain/file";
import { basename, parentDir } from "$lib/domain/path";
import { conflictResolver } from "./conflict-resolver.svelte";
import { operationsManager } from "./operations.svelte";
import { toastStore } from "./toast.svelte";
import { broadcastFileChange } from "./file-events";
import { frecencyStore } from "./frecency.svelte";

export interface SessionContext {
  onRefresh: () => unknown;
  onEntriesAdded?: (entries: FileEntry[]) => void;
  broadcastToOtherWindows?: boolean;
}

export interface SessionResult {
  /** Presentable failure text, or null when everything requested committed. */
  error: string | null;
  /** True only when every requested item reached the destination. */
  complete: boolean;
}

interface SessionKind {
  /** The operations-panel type, also the toast verb ("Copied"/"Moved"). */
  operation: "copy" | "move";
  past: string;
  run: (
    sources: readonly string[],
    destination: string,
    options: SessionOptions,
  ) => Promise<ApiResult<CopySessionOutcome>>;
  describe: (sources: readonly string[], outcome: CopySessionOutcome) => string | null;
  /** Directories the operation empties, which the destination set cannot cover. */
  vacated: (sources: readonly string[]) => string[];
}

export async function runSession(
  kind: SessionKind,
  requested: readonly string[],
  destination: string,
  context: SessionContext,
): Promise<SessionResult> {
  // Positions are the item identity, and relocating one entry twice is not a
  // second effect — the repeat would fail as a missing source and report the
  // whole request incomplete.
  const sources = kind.operation === "move" ? [...new Set(requested)] : requested;
  if (!sources.length) return { error: null, complete: true };
  const label = sources.length === 1 ? basename(sources[0]) : `${sources.length} items`;
  const operation = operationsManager.startOperation(kind.operation, label, destination);
  const cancellation = new AbortController();
  const deliveredEntries = new Set<string>();
  const unsubscribe = operationsManager.subscribeCancellation(operation.id, () => cancellation.abort());
  try {
    const result = await kind.run(sources, destination, {
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
    const error = kind.describe(sources, result.data);
    const cancelled = result.data.cancelled || cancellation.signal.aborted;
    if (committed.length) {
      const entries = committed.flatMap((receipt) => receipt.entry && !deliveredEntries.has(receipt.entry.path) ? [receipt.entry] : []);
      if (entries.length) context.onEntriesAdded?.(entries);
      broadcastFileChange([...new Set([
        destination,
        ...kind.vacated(sources),
        ...committed.map((receipt) => parentDir(receipt.path)),
      ])]);
      frecencyStore.pruneNonExistent();
    }
    if (error) operationsManager.failOperation(operation.id, error);
    else if (cancelled) operationsManager.cancelOperation(operation.id);
    else operationsManager.completeOperation(operation.id);

    const warnings = [...result.data.warnings, ...(result.warning ? [result.warning] : [])];
    const message = error ?? (committed.length && !cancelled
      ? `${kind.past} ${committed.length} item${committed.length === 1 ? "" : "s"} to ${basename(destination)}` : null);
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
