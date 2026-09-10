/** Raw native recovery leases deliberately outlive JS cleanup for lifetime tests. */
import { Channel } from "@tauri-apps/api/core";
import { extractError, invoke } from "../lib/api/common";
import { getNativeResourceSession } from "../lib/api/native-resource-session";
import type { FileRecoverySnapshot } from "../lib/domain/file-recovery";

export function startFileRecoveryProbe(signal: AbortSignal): void {
  let next = 9_000_000_000_000_000n;
  window.addEventListener("e2e-recovery-operation", ((event: CustomEvent<{
    token: string;
    op: "subscribe" | "unsubscribe" | "inspect" | "copy" | "copy-many";
    sessionId?: string;
    subscriptionId?: string;
    id?: string;
    source?: string;
    sources?: string[];
    destination?: string;
  }>) => {
    const { token, op } = event.detail;
    void (async () => {
      const sessionId = event.detail.sessionId ?? await getNativeResourceSession();
      signal.throwIfAborted();
      if (op === "copy-many") {
        const { copyFiles } = await import("../lib/state/copy-operations");
        signal.throwIfAborted();
        return copyFiles(event.detail.sources!, event.detail.destination!, { onRefresh: () => {} });
      }
      if (op === "copy") {
        const { performFileTransfer } = await import("../lib/state/file-transfer");
        signal.throwIfAborted();
        return performFileTransfer(event.detail.source!, event.detail.destination!, true, {
          overwrite: true, skipConflictCheck: true, onRefresh: () => {},
        });
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
