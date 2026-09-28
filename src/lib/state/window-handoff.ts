/** Application-level acknowledgement for moving a tab between webviews.
 * Native event delivery/window construction does not establish tab adoption. */
import { listen, emitTo } from "@tauri-apps/api/event";
import { isRecord, isWindowPath } from "$lib/domain/window-input";
import { logFrontendDiagnostic } from "$lib/api/frontend-log";

export const TAB_ADOPT_EVENT = "explorer://adopt-tab";
const ADOPTED_EVENT = "explorer://tab-adopted";

export interface WindowHandoff {
  sourceWindow: string;
  requestId: string;
}

export function normalizeWindowHandoff(raw: unknown): WindowHandoff | null {
  return isRecord(raw) && isWindowPath(raw.sourceWindow) && isWindowPath(raw.requestId)
    ? { sourceWindow: raw.sourceWindow, requestId: raw.requestId } : null;
}

/** The receiver calls this only after creating the destination tab. */
export async function acknowledgeWindowHandoff(raw: unknown, targetWindow: string): Promise<void> {
  await acknowledgeWindowRequest(raw, targetWindow, ADOPTED_EVENT);
}

export async function acknowledgeWindowRequest(raw: unknown, targetWindow: string, event: string, accepted = true): Promise<void> {
  const handoff = normalizeWindowHandoff(raw);
  if (handoff) await emitTo(handoff.sourceWindow, event, { requestId: handoff.requestId, targetWindow, ...(!accepted ? { accepted: false } : {}) });
}

/** Attach before dispatch, and retire late acquisitions after timeout. False
 * means the sender must retain its tab; only the target's matching ACK allows
 * removal. Timeout can leave a duplicate if the target adopted but lost its ACK. */
export function requestWindowHandoff(
  sourceWindow: string,
  targetWindow: string,
  dispatch: (handoff: WindowHandoff) => Promise<void>,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<boolean> {
  return requestWindowAcknowledgement(sourceWindow, targetWindow, dispatch, { event: ADOPTED_EVENT, timeoutMs, signal });
}

/** Shared correlated request/acknowledgement transport. A successful native
 * emit alone never establishes that the destination completed the operation. */
export function requestWindowAcknowledgement(
  sourceWindow: string,
  targetWindow: string,
  dispatch: (request: WindowHandoff) => Promise<void>,
  { event, timeoutMs = 10_000, signal }: { event: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<boolean> {
  const handoff = { sourceWindow, requestId: crypto.randomUUID() };
  return new Promise<boolean>((resolve) => {
    const startedAt = Date.now();
    let listeningAt: number | null = null;
    let dispatchedAt: number | null = null;
    let settled = false;
    let unlisten: (() => void) | undefined;
    const stopListening = (stop: () => void) => {
      const report = (error: unknown) => console.error("Window acknowledgement cleanup failed:", error);
      try { void Promise.resolve(stop()).catch(report); }
      catch (error) { report(error); }
    };
    const finish = (adopted: boolean, phase: string) => {
      if (settled) return;
      settled = true;
      if (import.meta.env.VITE_E2E_HOOKS === "1") {
        logFrontendDiagnostic("window handoff result", {
          sourceWindow, targetWindow, phase, adopted,
          elapsedMs: Date.now() - startedAt,
          listenMs: listeningAt === null ? null : listeningAt - startedAt,
          dispatchMs: dispatchedAt === null || listeningAt === null ? null : dispatchedAt - listeningAt,
        });
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (unlisten) stopListening(unlisten);
      unlisten = undefined;
      resolve(adopted);
    };
    const abort = () => finish(false, "abort");
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(false, "abort"); return; }
    void listen<unknown>(event, ({ payload }) => {
      if (isRecord(payload) && payload.requestId === handoff.requestId && payload.targetWindow === targetWindow
        && (payload.accepted === undefined || typeof payload.accepted === "boolean")) {
        finish(payload.accepted !== false, "acknowledgement");
      }
    }, { target: sourceWindow }).then(async (stop) => {
      if (settled) { stopListening(stop); return; }
      unlisten = stop;
      listeningAt = Date.now();
      await dispatch(handoff);
      dispatchedAt = Date.now();
    }).catch(() => finish(false, "listener-or-dispatch-error"));
  });
}
