import { Channel } from "@tauri-apps/api/core";
import type { CopyConflict, CopyDecision, CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import type { HistorySummary } from "$lib/domain/file-history";
import { extractError, invoke, isTauri, type ApiResult, virtualPathGuard } from "./common";
import { getNativeResourceSession, receiveHistorySummary } from "./native-resource-session";

interface MutationReply<T> { result: T; history: HistorySummary; warning?: string }

export interface CopyEntriesOptions {
  signal: AbortSignal;
  jobId: number;
  shared?: boolean;
  onConflict: (info: CopyConflict, signal: AbortSignal) => Promise<CopyDecision>;
  onEvent?: (event: CopySessionEvent) => void;
}

function cancelledOutcome(count: number): ApiResult<CopySessionOutcome> {
  return { ok: true, data: { items: Array.from({ length: count }, () => ({ status: "unstarted" as const })), cancelled: true, warnings: [] } };
}

export async function copyEntries(
  sources: readonly string[],
  destDir: string,
  options: CopyEntriesOptions,
): Promise<ApiResult<CopySessionOutcome>> {
  let guard = virtualPathGuard(destDir);
  for (let index = 0; !guard && index < sources.length; index += 1) {
    guard = virtualPathGuard(sources[index]);
  }
  if (guard) return guard;
  if (options.signal.aborted) return cancelledOutcome(sources.length);

  const requestId = crypto.randomUUID();
  let sessionId: string;
  try {
    sessionId = await getNativeResourceSession();
  } catch (error) {
    return { ok: false, error: extractError(error) };
  }
  if (options.signal.aborted) return cancelledOutcome(sources.length);

  let active = true;
  let ready = false;
  let cancelRequested = false;
  let cancelSent = false;
  let prompt: { item: number; nonce: string; controller: AbortController } | null = null;
  const abortPrompt = () => {
    const current = prompt;
    prompt = null;
    current?.controller.abort();
  };
  const seenConflicts = new Set<string>();
  let rejectControl!: (error: unknown) => void;
  const controlFailure = new Promise<never>((_, reject) => { rejectControl = reject; });
  const failControl = (error: unknown) => {
    if (!active) return;
    active = false;
    abortPrompt();
    if (ready && !cancelSent) {
      cancelSent = true;
      void invoke<void>("cancel_copy_session", { sessionId, requestId }).catch(() => {});
    }
    rejectControl(error);
  };
  const cancelNative = () => {
    if (cancelSent) return;
    cancelSent = true;
    void invoke<void>("cancel_copy_session", { sessionId, requestId }).catch(failControl);
  };
  const abort = () => {
    cancelRequested = true;
    abortPrompt();
    if (ready) void cancelNative();
  };
  options.signal.addEventListener("abort", abort, { once: true });

  const receive = (event: CopySessionEvent) => {
    if (!active) return;
    if (event.type === "ready") ready = true;
    try { options.onEvent?.(event); } catch (error) { failControl(error); return; }
    if (event.type === "ready") {
      if (cancelRequested || options.signal.aborted) void cancelNative();
      return;
    }
    if (event.type !== "conflict" || prompt) return;
    const conflictKey = `${event.item}\0${event.nonce}`;
    if (seenConflicts.has(conflictKey)) return;
    seenConflicts.add(conflictKey);
    const controller = new AbortController();
    const current = { item: event.item, nonce: event.nonce, controller };
    prompt = current;
    let decision: Promise<CopyDecision>;
    try {
      decision = Promise.resolve(options.onConflict(event.conflict, controller.signal));
    } catch (error) {
      failControl(error);
      return;
    }
    void decision.then(
      async (decision) => {
        if (!active || controller.signal.aborted || prompt !== current) return;
        // Native may synchronously publish the next conflict while accepting
        // this reply; release the prompt slot before entering the transport.
        prompt = null;
        try {
          await invoke<void>("resolve_copy_conflict", {
            sessionId, requestId, item: event.item, nonce: event.nonce, decision,
          });
        } catch (error) {
          controller.abort();
          throw error;
        }
      },
      (error) => {
        if (!controller.signal.aborted) throw error;
      },
    ).catch(failControl);
  };
  const events = isTauri() ? new Channel<CopySessionEvent>(receive) : receive;

  try {
    const invocation = invoke<MutationReply<CopySessionOutcome>>("copy_entries", {
      sessionId,
      request: {
        requestId, sources: [...sources], destDir, jobId: options.jobId,
        shared: options.shared ?? false,
      },
      events,
    });
    // Keep a losing invocation observed when a control command fails first.
    void invocation.catch(() => {});
    const reply = await Promise.race([invocation, controlFailure]);
    receiveHistorySummary(reply.history);
    return { ok: true, data: reply.result, ...(reply.warning ? { warning: reply.warning } : {}) };
  } catch (error) {
    return { ok: false, error: extractError(error) };
  } finally {
    active = false;
    options.signal.removeEventListener("abort", abort);
    abortPrompt();
  }
}
