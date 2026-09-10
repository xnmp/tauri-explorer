/** Native mutation replies carry already-settled history. Consume its revision
 * before exposing the filesystem receipt to the invoking feature. */
import { invoke, extractError, type ApiResult } from "./common";
import { getNativeResourceSession, receiveHistorySummary } from "./native-resource-session";
import type { HistorySummary } from "$lib/domain/file-history";

interface MutationReply<T> { result: T; history: HistorySummary; warning?: string }

export async function invokeFileMutation<T>(command: string, args: Record<string, unknown>): Promise<ApiResult<T>> {
  try {
    const sessionId = await getNativeResourceSession();
    const reply = await invoke<MutationReply<T>>(command, { ...args, sessionId });
    receiveHistorySummary(reply.history);
    return { ok: true, data: reply.result, ...(reply.warning ? { warning: reply.warning } : {}) };
  } catch (error) {
    return { ok: false, error: extractError(error) };
  }
}
