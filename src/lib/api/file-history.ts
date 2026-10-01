import { invoke, extractError } from "./common";
import { getNativeResourceSession, receiveHistorySummary, subscribeHistorySummary, currentHistorySummary } from "./native-resource-session";
import type { HistoryPort, HistoryReply } from "$lib/domain/file-history";

async function request(command: string, args?: Record<string, unknown>): Promise<HistoryReply> {
  try {
    const sessionId = await getNativeResourceSession();
    const reply = await invoke<HistoryReply>(command, { ...args, sessionId });
    receiveHistorySummary(reply.summary);
    return reply;
  } catch (error) {
    return { summary: currentHistorySummary(), error: extractError(error) };
  }
}

export const fileHistoryPort: HistoryPort = {
  subscribe: subscribeHistorySummary,
  push: (action, shared) => request("file_history_push", { action, shared }),
  clear: () => request("file_history_clear"),
  execute: (direction, expectedEntryId) => request("file_history_execute", { direction, expectedEntryId }),
};
