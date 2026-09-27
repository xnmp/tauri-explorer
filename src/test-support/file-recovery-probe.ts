/** Raw native recovery leases deliberately outlive JS cleanup for lifetime tests. */
import { Channel } from "@tauri-apps/api/core";
import { extractError, invoke } from "../lib/api/common";
import { getNativeResourceSession } from "../lib/api/native-resource-session";
import type { FileRecoverySnapshot } from "../lib/domain/file-recovery";

export function startFileRecoveryProbe(signal: AbortSignal): void {
  let next = 9_000_000_000_000_000n;
  window.addEventListener("e2e-recovery-operation", ((event: CustomEvent<{
    token: string;
    op: "subscribe" | "unsubscribe" | "inspect" | "list" | "copy" | "move" | "copy-many" | "cancel-copy" | "cancel-move";
    sessionId?: string;
    subscriptionId?: string;
    id?: string;
    source?: string;
    sources?: string[];
    shared?: boolean;
    destination?: string;
  }>) => {
    const { token, op } = event.detail;
    void (async () => {
      const sessionId = event.detail.sessionId ?? await getNativeResourceSession();
      signal.throwIfAborted();
      if (op === "copy-many") {
        const { copyFiles } = await import("../lib/state/copy-operations");
        signal.throwIfAborted();
        return copyFiles(event.detail.sources!, event.detail.destination!, { onRefresh: () => {}, broadcastToOtherWindows: event.detail.shared });
      }
      if (op === "cancel-copy" || op === "cancel-move") {
        const { runOrderedSession } = await import("../lib/api/copy-session");
        const controller = new AbortController();
        signal.addEventListener("abort", () => controller.abort(), { once: true });
        return runOrderedSession(
          op === "cancel-copy" ? "copy_entries" : "move_entries",
          [event.detail.source!],
          event.detail.destination!,
          {
            signal: controller.signal,
            jobId: Number(++next),
            onConflict: async () => ({ choice: "cancel", applyToAll: false }),
            onEvent: (sessionEvent) => {
              if (sessionEvent.type === "ready") controller.abort();
            },
          },
        );
      }
      if (op === "copy") {
        const { copyEntries } = await import("../lib/api/copy-session");
        signal.throwIfAborted();
        const result = await copyEntries([event.detail.source!], event.detail.destination!, {
          signal,
          jobId: Number(++next),
          onConflict: async () => ({ choice: "overwrite", applyToAll: true }),
        });
        if (!result.ok) return result;
        const item = result.data.items[0];
        return item?.status === "succeeded"
          ? { ok: true, ...item.receipt }
          : { ok: false, error: item?.status === "failed" || item?.status === "uncertain" ? item.error : "Copy did not complete" };
      }
      if (op === "move") {
        const { performFileTransfer } = await import("../lib/state/file-transfer");
        signal.throwIfAborted();
        return performFileTransfer(event.detail.source!, event.detail.destination!, {
          overwrite: true, skipConflictCheck: true, onRefresh: () => {},
        });
      }
      if (op === "list") {
        return invoke<FileRecoverySnapshot>("file_recovery_list", { sessionId });
      }
      if (op === "inspect") {
        return invoke<FileRecoverySnapshot>("file_recovery_inspect", { sessionId, id: event.detail.id });
      }
      const subscriptionId = event.detail.subscriptionId ?? (++next).toString();
      if (op === "unsubscribe") {
        await invoke("file_recovery_unsubscribe", { sessionId, subscriptionId });
        return { sessionId, subscriptionId };
      }
      const updates = new Channel<FileRecoverySnapshot>((snapshot) => {
        if (!signal.aborted) document.documentElement.dataset.e2eRecoverySnapshot = JSON.stringify({ token, subscriptionId, snapshot });
      });
      const snapshot = await invoke<FileRecoverySnapshot>("file_recovery_subscribe", { sessionId, subscriptionId, updates });
      return { sessionId, subscriptionId, channel: updates.id, snapshot };
    })().then((result) => {
      if (!signal.aborted) document.documentElement.dataset.e2eRecoveryResult = JSON.stringify({ token, result });
    }, (error: unknown) => {
      if (!signal.aborted) document.documentElement.dataset.e2eRecoveryResult = JSON.stringify({ token, error: extractError(error) });
    });
  }) as EventListener, { signal });
  document.documentElement.dataset.e2eRecoveryReady = "true";
  signal.addEventListener("abort", () => {
    for (const key of ["e2eRecoveryReady", "e2eRecoveryResult", "e2eRecoverySnapshot"]) {
      delete document.documentElement.dataset[key];
    }
  }, { once: true });
}
