/** Private browser fixture ledger. Controls never invoke a provider or invent completion; inactive operations mirror host settlement. */
import { nativeJobSettled, nativeJobTerminal, validNativeSnapshot, type NativeJobRecord, type NativeJobSnapshot } from "$lib/domain/native-plugin-jobs";
import { aiOperationKey, resolutionAvailable, validAiOperations, type AiOperationsSnapshot, type AiResolution } from "$lib/domain/ai-operations";
export function createMockAiPresentation(emit: (name: string, value: unknown) => void) {
  let jobs: NativeJobRecord[] = [], watermark = 0;
  let operations: AiOperationsSnapshot = { version: 1, operations: [] };
  const calls: { command: string; identity: string; action?: string }[] = [];
  const snapshot = (): NativeJobSnapshot => structuredClone({ originWindow: "mock-window", watermark, jobs });
  const operationSnapshot = () => structuredClone(operations);
  const job = (key: string) => { const current = jobs.find(r => r.jobKey === key); if (!current) throw new Error("Retained job is unavailable"); return current; };
  function autoSettle(): void {
    const pending = operations.operations;
    const retained = [] as AiOperationsSnapshot["operations"];
    for (const operation of pending) {
      const linked = jobs.filter(r => r.owner.packageId === operation.consumerPackage && r.operationId === operation.operationId);
      const active = operation.active ?? linked.some(r => ["accepting", "running", "recovering"].includes(r.state));
      if (active || operation.delivery === "delivered") { retained.push(operation); continue; }
      // Only successful original output can be driven. Unknown execution is
      // never resumed, even when a malformed fixture claims it canResume.
      // Success keeps its original output and evidence for every delivery
      // state. Missing/corrupt delivery is retried silently on later passes.
      const recoverable = operation.execution === "succeeded";
      if (recoverable) {
        const deliveryFailed = operation.delivery === "unavailable" && ["missing", "corrupt"].includes(operation.deliveryReason ?? "");
        if (deliveryFailed) jobs = jobs.map(r => linked.includes(r) && !nativeJobTerminal(r.state)
          ? { ...r, revision: ++watermark, updatedAtMs: Date.now(), settledAtMs: r.settledAtMs ?? Date.now(), state: "error", phase: "delivery_failed", error: r.error || "Original output could not be delivered; recovery will retry automatically" } : r);
        if (!operation.canResume) { retained.push(operation); continue; }
        calls.push({ command: "resume", identity: aiOperationKey(operation) });
        retained.push({ ...operation, active: !deliveryFailed });
        jobs = jobs.map(r => linked.includes(r) && !nativeJobTerminal(r.state)
          ? { ...r, revision: ++watermark, updatedAtMs: Date.now(), settledAtMs: undefined, state: "recovering", phase: "acquiring", error: undefined } : r);
      } else {
        calls.push({ command: "auto-settle", identity: aiOperationKey(operation), action: "dismiss" });
        jobs = jobs.map(r => {
          if (!linked.includes(r)) return r;
          if (!nativeJobTerminal(r.state)) return { ...r, revision: ++watermark, updatedAtMs: Date.now(), settledAtMs: r.settledAtMs ?? Date.now(), state: "discarded", phase: "stopped", error: r.error || operation.reason };
          if (r.state === "error" && !r.error) return { ...r, revision: ++watermark, updatedAtMs: Date.now(), error: operation.reason };
          return r;
        });
      }
    }
    operations = { ...operations, operations: retained };
  }
  return {
    calls,
    snapshot,
    operationSnapshot,
    /** Fixtures supply authoritative outcomes explicitly, including terminal completion. */
    seed(next: NativeJobSnapshot, operationState: AiOperationsSnapshot = operations): void {
      if (!validNativeSnapshot(next) || !validAiOperations(operationState)) throw new Error("Invalid native presentation fixture");
      jobs = structuredClone(next.jobs); watermark = next.watermark; operations = structuredClone(operationState);
      autoSettle();
      for (const r of jobs) emit("plugin-jobs:changed", { type: "updated", job: structuredClone(r) });
      emit("ai:operations-changed", null);
    },
    cancel(key: string): void { const current = job(key); if (nativeJobTerminal(current.state)) return; calls.push({ command: "cancel", identity: key }); },
    resume(key: string): void { job(key); calls.push({ command: "resume", identity: key }); },
    dismiss(key: string): void {
      const current = job(key); if (!nativeJobSettled(current)) throw new Error("Active jobs cannot be dismissed");
      calls.push({ command: "dismiss", identity: key }); jobs = jobs.filter(r => r.jobKey !== key);
      emit("plugin-jobs:changed", { type: "dismissed", jobKey: key, revision: ++watermark });
    },
    resolve(consumerPackage: string, operationId: string, action: AiResolution): AiOperationsSnapshot {
      const current = operations.operations.find(r => r.consumerPackage === consumerPackage && r.operationId === operationId);
      if (!current || !["resume", "discard", "stop", "dismiss"].includes(action) || !resolutionAvailable(current, action)) throw new Error("Original operation action is unavailable; reload its retained status");
      calls.push({ command: "resolve", identity: aiOperationKey(current), action });
      if (action === "dismiss") {
        operations = { ...operations, operations: operations.operations.filter(r => r !== current) };
        jobs = jobs.map(r => r.owner.packageId === consumerPackage && r.operationId === operationId && r.phase === "stopped" && !nativeJobTerminal(r.state)
          ? { ...r, revision: ++watermark, updatedAtMs: Date.now(), state: "discarded" as const } : r);
      } else if (action !== "resume") {
        operations = { ...operations, operations: action === "discard" ? operations.operations.filter(r => r !== current) : operations.operations.map(r => r === current ? { ...r, active: false, canStop: false, canResume: false, canDismiss: current.execution === "unknown" && current.delivery === "none", reason: "Active recovery stopped. Unknown outcome evidence remains retained." } : r) };
        jobs = jobs.map(r => r.owner.packageId === consumerPackage && r.operationId === operationId && !nativeJobTerminal(r.state)
          ? { ...r, revision: ++watermark, updatedAtMs: Date.now(), settledAtMs: Date.now(), state: action === "discard" ? "discarded" : "needs_attention", phase: action === "discard" ? "provider_result_discarded" : "stopped" } : r);
      }
      autoSettle();
      for (const r of jobs) emit("plugin-jobs:changed", { type: "updated", job: structuredClone(r) });
      emit("ai:operations-changed", null); return operationSnapshot();
    },
  };
}
export type MockAiPresentation = ReturnType<typeof createMockAiPresentation>;
