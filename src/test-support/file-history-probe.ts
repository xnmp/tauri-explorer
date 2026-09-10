/** Native acceptance observes the production channel and invokes the real IPC
 * authority. No local history model or filesystem executor is substituted. */
import { fileHistoryPort } from "$lib/api/file-history";
import { getNativeResourceSession } from "$lib/api/native-resource-session";
import type { HistoryDirection, UndoAction } from "$lib/domain/file-history";

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
  signal.addEventListener("abort", () => {
    unsubscribe();
    for (const key of ["e2eHistoryReady", "e2eHistorySummary", "e2eHistoryResult"]) delete root.dataset[key];
  }, { once: true });
  void getNativeResourceSession().then(() => {
    if (!signal.aborted) root.dataset.e2eHistoryReady = "true";
  }).catch((error) => {
    if (!signal.aborted) root.dataset.e2eHistoryReady = String(error);
  });
  window.addEventListener("e2e-history-operation", ((event: CustomEvent<Request>) => {
    const request = event.detail;
    void (async () => {
      if (request.op === "clear") return fileHistoryPort.clear();
      if (request.op === "push" && request.action) {
        return fileHistoryPort.push(request.action, request.shared ?? false);
      }
      if (request.op === "execute" && request.direction && request.expectedEntryId !== undefined) {
        return fileHistoryPort.execute(request.direction, request.expectedEntryId);
      }
      throw new Error("Invalid history probe request");
    })().then((result) => {
      if (!signal.aborted) root.dataset.e2eHistoryResult = JSON.stringify({ token: request.token, result });
    }, (error) => {
      if (!signal.aborted) root.dataset.e2eHistoryResult = JSON.stringify({ token: request.token, error: String(error) });
    });
  }) as EventListener, { signal });
}
