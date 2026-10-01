/** Native acceptance observes the production channel and invokes the real IPC
 * authority. No local history model or filesystem executor is substituted. */
import { fileHistoryPort } from "$lib/api/file-history";
import { getNativeResourceSession } from "$lib/api/native-resource-session";
import type { HistoryDirection, UndoAction } from "$lib/domain/file-history";
import { createDomRpc } from "./dom-rpc";

interface Request {
  token: string;
  op: "push" | "execute" | "clear";
  action?: UndoAction;
  shared?: boolean;
  direction?: HistoryDirection;
  expectedEntryId?: number;
}

export function startFileHistoryProbe(signal: AbortSignal): void {
  if (signal.aborted) return;
  const root = document.documentElement;
  const unsubscribe = fileHistoryPort.subscribe((summary) => {
    if (!signal.aborted) root.dataset.e2eHistorySummary = JSON.stringify(summary);
  });
  signal.addEventListener("abort", unsubscribe, { once: true });
  void getNativeResourceSession().then(() => {
    if (!signal.aborted) root.dataset.e2eHistoryReady = "true";
  }).catch((error) => {
    if (!signal.aborted) root.dataset.e2eHistoryReady = String(error);
  });
  createDomRpc<Request>({
    event: "e2e-history-operation",
    resultKey: "e2eHistoryResult",
    ownedKeys: ["e2eHistoryReady", "e2eHistorySummary"],
    signal,
    handlers: {
      clear: () => fileHistoryPort.clear(),
      push: ({ action, shared }) => {
        if (!action) throw new Error("Invalid history probe request");
        return fileHistoryPort.push(action, shared ?? false);
      },
      execute: ({ direction, expectedEntryId }) => {
        if (!direction || expectedEntryId === undefined) throw new Error("Invalid history probe request");
        return fileHistoryPort.execute(direction, expectedEntryId);
      },
    },
  });
}
