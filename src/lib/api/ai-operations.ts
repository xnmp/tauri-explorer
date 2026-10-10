import { invoke, isTauri } from "./common";
import { listen } from "@tauri-apps/api/event";
import { validAiOperations, type AiOperationsSnapshot, type AiResolution, type UnresolvedAiOperation } from "$lib/domain/ai-operations";
function validate(value: unknown): AiOperationsSnapshot {
  if (!validAiOperations(value)) throw new Error("Unresolved AI operations returned invalid metadata. Retain the operation and reload.");
  return value;
}
export const readAiOperations = async () => validate(await invoke<unknown>("ai_operations_snapshot", {}));
export const resolveAiOperation = async (operation: UnresolvedAiOperation, action: AiResolution) => validate(await invoke<unknown>("ai_operation_resolve", { consumerPackage: operation.consumerPackage, operationId: operation.operationId, action }));
export async function watchAiOperations(receive: () => void): Promise<() => void> {
  const names = ["ai:operations-changed", "ai:image-migration-changed", "plugin-jobs:changed", "plugins:changed"];
  if (isTauri()) {
    const results = await Promise.allSettled(names.map((name) => listen(name, receive)));
    const stops = results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") { stops.forEach((stop) => stop()); throw failure.reason; }
    return () => stops.forEach((stop) => stop());
  }
  names.forEach((name) => window.addEventListener(name, receive));
  return () => names.forEach((name) => window.removeEventListener(name, receive));
}
