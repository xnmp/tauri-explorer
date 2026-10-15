/** Safe operation identities and available native resolution actions. No prompts or keys. */
export type AiResolution = "resume" | "discard" | "stop" | "dismiss";
export interface AiOperation {
  operationId: string; consumerPackage: string; providerPackage: string; createdAtMs: number | null;
  execution: string; delivery: string; reason: string; canResume: boolean; canDiscard: boolean; canStop: boolean;
  /** True while a live job still drives the operation (in progress, nothing for the user to resolve). Absent in older snapshots. */
  active?: boolean;
  /** Private fixture evidence from the original delivery receipt; absent in older snapshots. */
  deliveryReason?: string;
  /** Recovery stopped, execution unknown, nothing retained: eligible for automatic settlement. Absent in older snapshots. */
  canDismiss?: boolean;
}
export interface AiOperationsSnapshot {
  version: 1; operations: AiOperation[]; migration?: { state: "pending" | "complete" | "absent"; error?: string };
}
export const aiOperationKey = (r: AiOperation): string => JSON.stringify([r.consumerPackage, r.operationId]);
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
      || r.deliveryReason !== undefined && !bounded(r.deliveryReason, 128)
      || ![r.canResume, r.canDiscard, r.canStop].every((v) => typeof v === "boolean") || r.active !== undefined && typeof r.active !== "boolean" || r.canDismiss !== undefined && typeof r.canDismiss !== "boolean" || keys.has(aiOperationKey(r))) return false;
    keys.add(aiOperationKey(r));
  }
  return s.migration === undefined || !!s.migration && ["pending", "complete", "absent"].includes(s.migration.state)
    && (s.migration.error === undefined || bounded(s.migration.error, 2048));
}
/** Native action capabilities retained for the private browser backend fixture. */
export const resolutionAvailable = (r: AiOperation, action: AiResolution): boolean =>
  action === "resume" ? r.canResume : action === "discard" ? r.canDiscard : action === "dismiss" ? r.canDismiss === true : r.canStop;
