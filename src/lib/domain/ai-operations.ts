/** Safe operation identities and available native resolution actions. No prompts or keys. */
export type AiResolution = "resume" | "discard" | "stop";
export interface UnresolvedAiOperation {
  operationId: string; consumerPackage: string; providerPackage: string; createdAtMs: number | null;
  execution: string; delivery: string; reason: string; canResume: boolean; canDiscard: boolean; canStop: boolean;
}
export interface AiOperationsSnapshot {
  version: 1; operations: UnresolvedAiOperation[]; migration?: { state: "pending" | "complete" | "absent"; error?: string };
}
export const aiOperationKey = (r: UnresolvedAiOperation): string => JSON.stringify([r.consumerPackage, r.operationId]);
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && new TextEncoder().encode(v).length <= max && !v.includes("\0");
export function validAiOperations(value: unknown): value is AiOperationsSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as AiOperationsSnapshot;
  if (s.version !== 1 || !Array.isArray(s.operations) || s.operations.length > 256) return false;
  const keys = new Set<string>();
  for (const r of s.operations) {
    if (!r || ![r.consumerPackage, r.providerPackage].every((p) => typeof p === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(p))
      || typeof r.operationId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(r.operationId)
      || r.createdAtMs !== null && (!Number.isSafeInteger(r.createdAtMs) || r.createdAtMs < 0)
      || !bounded(r.execution, 128) || !bounded(r.delivery, 128) || !bounded(r.reason, 2048)
      || ![r.canResume, r.canDiscard, r.canStop].every((v) => typeof v === "boolean") || keys.has(aiOperationKey(r))) return false;
    keys.add(aiOperationKey(r));
  }
  return s.migration === undefined || !!s.migration && ["pending", "complete", "absent"].includes(s.migration.state)
    && (s.migration.error === undefined || bounded(s.migration.error, 2048));
}
export const resolutionAvailable = (r: UnresolvedAiOperation, action: AiResolution): boolean =>
  action === "resume" ? r.canResume : action === "discard" ? r.canDiscard : r.canStop;
export function resolutionCopy(r: UnresolvedAiOperation, action: "discard" | "stop"): { title: string; body: string; button: string } {
  return action === "discard"
    ? { title: "Discard this retained result?", body: `Discard the provider result for operation ${r.operationId}, owned by ${r.consumerPackage}. Its image bytes will be released after the disposition is durable. Generation will not run again.`, button: "Discard retained result" }
    : { title: "Stop recovery for this operation?", body: `Stop active recovery for operation ${r.operationId}, owned by ${r.consumerPackage}. Unknown outcome evidence remains retained. This does not declare that generation failed or that no charge occurred.`, button: "Stop active recovery" };
}
