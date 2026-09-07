import { Channel } from "@tauri-apps/api/core";
import { invoke, isTauri } from "./common";
import { emptyHistorySummary, type HistorySummary } from "$lib/domain/file-history";

// One acknowledged native resource generation per JavaScript realm. A renderer
// reload creates a fresh module cache; commands already sent by the old realm
// retain its session ID and cannot acquire resources for the replacement page.
let session: Promise<string> | undefined;
let historySummary = emptyHistorySummary();
const historyListeners = new Set<(summary: HistorySummary) => void>();

export const currentHistorySummary = (): HistorySummary => historySummary;
export function receiveHistorySummary(summary: HistorySummary): void {
  if (summary.revision <= historySummary.revision) return;
  historySummary = summary;
  for (const receive of historyListeners) receive(summary);
}
export function subscribeHistorySummary(receive: (summary: HistorySummary) => void): () => void {
  historyListeners.add(receive);
  receive(historySummary);
  return () => historyListeners.delete(receive);
}

export function getNativeResourceSession(): Promise<string> {
  if (session) return session;

  let acknowledgement: Promise<string>;
  const historyChannel = isTauri() ? new Channel<HistorySummary>(receiveHistorySummary) : receiveHistorySummary;
  acknowledgement = invoke<string>("native_resource_session", { historyChannel }).catch((error) => {
    // Only a failed acknowledgement permits retry. A stale rejection from any
    // later resource command must keep using this ID and fail closed.
    if (session === acknowledgement) session = undefined;
    throw error;
  });
  session = acknowledgement;
  return acknowledgement;
}
