/** Private browser fixture ledger. Controls never invoke a provider or invent completion. */
import { nativeJobSettled, nativeJobTerminal, validNativeSnapshot, type NativeJobRecord, type NativeJobSnapshot } from "$lib/domain/native-plugin-jobs";
import { aiOperationKey, resolutionAvailable, validAiOperations, type AiOperationsSnapshot, type AiResolution } from "$lib/domain/ai-operations";
export function createMockAiPresentation(emit: (name: string, value: unknown) => void) {
  let jobs: NativeJobRecord[] = [], watermark = 0;
  let operations: AiOperationsSnapshot = { version: 1, operations: [] };
  const calls: { command: string; identity: string; action?: string }[] = [];
  const snapshot = (): NativeJobSnapshot => structuredClone({ originWindow: "mock-window", watermark, jobs });
  const operationSnapshot = () => structuredClone(operations);
  const job = (key: string) => { const current = jobs.find(r => r.jobKey === key); if (!current) throw new Error("Retained job is unavailable"); return current; };
  return {
    calls,
    snapshot,
    operationSnapshot,
    /** Fixtures supply authoritative outcomes explicitly, including terminal completion. */
    seed(next: NativeJobSnapshot, unresolved: AiOperationsSnapshot = operations): void {
      if (!validNativeSnapshot(next) || !validAiOperations(unresolved)) throw new Error("Invalid native presentation fixture");
      jobs = structuredClone(next.jobs); watermark = next.watermark; operations = structuredClone(unresolved);
      emit("ai:operations-changed", null);
    },
    cancel(key: string): void { const current = job(key); if (nativeJobTerminal(current.state)) return; calls.push({ command: "cancel", identity: key }); },
    resume(key: string): void { job(key); calls.push({ command: "resume", identity: key }); },
    dismiss(key: string): void {
      const current = job(key); if (!nativeJobSettled(current)) throw new Error("Active or unresolved jobs cannot be dismissed");
      calls.push({ command: "dismiss", identity: key }); jobs = jobs.filter(r => r.jobKey !== key);
      emit("plugin-jobs:changed", { type: "dismissed", jobKey: key, revision: ++watermark });
    },
    resolve(consumerPackage: string, operationId: string, action: AiResolution): AiOperationsSnapshot {
      const current = operations.operations.find(r => r.consumerPackage === consumerPackage && r.operationId === operationId);
      if (!current || !["resume", "discard", "stop"].includes(action) || !resolutionAvailable(current, action)) throw new Error("Original operation action is unavailable; reload its retained status");
      calls.push({ command: "resolve", identity: aiOperationKey(current), action });
      if (action !== "resume") {
        operations = { ...operations, operations: action === "discard" ? operations.operations.filter(r => r !== current) : operations.operations.map(r => r === current ? { ...r, canStop: false, canResume: false, reason: "Active recovery stopped. Unknown outcome evidence remains retained." } : r) };
        jobs = jobs.map(r => r.owner.packageId === consumerPackage && r.operationId === operationId && !nativeJobTerminal(r.state)
          ? { ...r, revision: ++watermark, updatedAtMs: Date.now(), state: "needs_attention", phase: action === "discard" ? "provider_result_discarded" : "stopped" } : r);
        for (const r of jobs.filter(r => r.owner.packageId === consumerPackage && r.operationId === operationId && !nativeJobTerminal(r.state))) emit("plugin-jobs:changed", { type: "updated", job: structuredClone(r) });
      }
      emit("ai:operations-changed", null); return operationSnapshot();
    },
  };
}
export type MockAiPresentation = ReturnType<typeof createMockAiPresentation>;
