/** Raw native recovery leases deliberately outlive JS cleanup for lifetime tests. */
import { Channel } from "@tauri-apps/api/core";
import { extractError, invoke } from "../lib/api/common";
import { getNativeResourceSession } from "../lib/api/native-resource-session";
import type { FileRecoverySnapshot } from "../lib/domain/file-recovery";
import { createDomRpc } from "./dom-rpc";

interface RecoveryRequest {
  token: string;
  op: "subscribe" | "unsubscribe" | "inspect" | "list" | "copy" | "move" | "copy-many" | "move-many" | "cancel-copy" | "cancel-move" | "complete-copy" | "complete-move";
  sessionId?: string;
  subscriptionId?: string;
  id?: string;
  source?: string;
  sources?: string[];
  shared?: boolean;
  destination?: string;
}

export function startFileRecoveryProbe(signal: AbortSignal): void {
  let next = 9_000_000_000_000_000n;
  const session = async (request: RecoveryRequest) => {
    const sessionId = request.sessionId ?? await getNativeResourceSession();
    signal.throwIfAborted();
    return sessionId;
  };

  const cancelSession = async (request: RecoveryRequest) => {
    await session(request);
    const { runOrderedSession } = await import("../lib/api/copy-session");
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    return runOrderedSession(
      request.op === "cancel-copy" ? "copy_entries" : "move_entries",
      request.sources ?? [request.source!],
      request.destination!,
      {
        signal: controller.signal,
        jobId: Number(++next),
        // The native conflict remains parked until cancel_copy_session
        // settles it. A conflict decision would let this test pass even
        // if abort never reached the session registry.
        onConflict: () => new Promise<never>(() => {}),
        onEvent: (sessionEvent) => {
          if (sessionEvent.type === "conflict") controller.abort();
        },
      },
    );
  };

  const completeSession = async (request: RecoveryRequest) => {
    await session(request);
    const { runOrderedSession } = await import("../lib/api/copy-session");
    return runOrderedSession(
      request.op === "complete-copy" ? "copy_entries" : "move_entries",
      [request.source!],
      request.destination!,
      {
        signal,
        jobId: Number(++next),
        onConflict: async () => ({ choice: "overwrite", applyToAll: false }),
      },
    );
  };

  createDomRpc<RecoveryRequest>({
    event: "e2e-recovery-operation",
    resultKey: "e2eRecoveryResult",
    readyKey: "e2eRecoveryReady",
    ownedKeys: ["e2eRecoverySnapshot"],
    signal,
    formatError: extractError,
    handlers: {
      "move-many": async (request) => {
        await session(request);
        const { moveFiles } = await import("../lib/state/move-operations");
        signal.throwIfAborted();
        return moveFiles(request.sources!, request.destination!, {
          onRefresh: () => {}, broadcastToOtherWindows: request.shared,
        });
      },
      "copy-many": async (request) => {
        await session(request);
        const { copyFiles } = await import("../lib/state/copy-operations");
        signal.throwIfAborted();
        return copyFiles(request.sources!, request.destination!, {
          onRefresh: () => {}, broadcastToOtherWindows: request.shared,
        });
      },
      "cancel-copy": cancelSession,
      "cancel-move": cancelSession,
      "complete-copy": completeSession,
      "complete-move": completeSession,
      copy: async (request) => {
        await session(request);
        const { copyEntries } = await import("../lib/api/copy-session");
        signal.throwIfAborted();
        const result = await copyEntries([request.source!], request.destination!, {
          signal,
          jobId: Number(++next),
          onConflict: async () => ({ choice: "overwrite", applyToAll: true }),
        });
        if (!result.ok) return result;
        const item = result.data.items[0];
        return item?.status === "succeeded"
          ? { ok: true, ...item.receipt }
          : { ok: false, error: item?.status === "failed" || item?.status === "uncertain" ? item.error : "Copy did not complete" };
      },
      move: async (request) => {
        await session(request);
        const { runOrderedSession } = await import("../lib/api/copy-session");
        signal.throwIfAborted();
        const result = await runOrderedSession("move_entries", [request.source!], request.destination!, {
          signal,
          jobId: Number(++next),
          onConflict: async () => ({ choice: "overwrite", applyToAll: true }),
        });
        if (!result.ok) return result;
        const item = result.data.items[0];
        return item?.status === "succeeded"
          ? { ok: true, ...item.receipt }
          : { ok: false, error: item?.status === "failed" || item?.status === "uncertain" ? item.error : "Move did not complete" };
      },
      list: async (request) => invoke<FileRecoverySnapshot>("file_recovery_list", {
        sessionId: await session(request),
      }),
      inspect: async (request) => invoke<FileRecoverySnapshot>("file_recovery_inspect", {
        sessionId: await session(request), id: request.id,
      }),
      unsubscribe: async (request) => {
        const sessionId = await session(request);
        const subscriptionId = request.subscriptionId ?? (++next).toString();
        await invoke("file_recovery_unsubscribe", { sessionId, subscriptionId });
        return { sessionId, subscriptionId };
      },
      subscribe: async (request) => {
        const sessionId = await session(request);
        const subscriptionId = request.subscriptionId ?? (++next).toString();
        const updates = new Channel<FileRecoverySnapshot>((snapshot) => {
          if (!signal.aborted) {
            document.documentElement.dataset.e2eRecoverySnapshot = JSON.stringify({
              token: request.token, subscriptionId, snapshot,
            });
          }
        });
        const snapshot = await invoke<FileRecoverySnapshot>("file_recovery_subscribe", {
          sessionId, subscriptionId, updates,
        });
        return { sessionId, subscriptionId, channel: updates.id, snapshot };
      },
    },
  });
}
