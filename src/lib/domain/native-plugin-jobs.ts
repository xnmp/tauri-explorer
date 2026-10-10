/** Native presentation receipts. Pure rules; host revisions order observations. */
export type NativeJobState = "accepting" | "running" | "recovering" | "needs_attention" | "completed" | "error" | "cancelled" | "discarded";
export interface NativeJobRecord {
  jobKey: string; owner: { packageId: string; digest: string; incarnation: number }; operationId: string; jobId: number;
  kind: string; label: string; originWindow: string; revision: number; sourceRevision?: number;
  createdAtMs: number; updatedAtMs: number; state: NativeJobState; phase?: string | null; outputPath?: string | null; runId?: number | null; error?: string | null;
}
export interface NativeJobSnapshot { originWindow: string; watermark: number; jobs: NativeJobRecord[] }
export type NativeJobEvent = { type: "updated"; job: NativeJobRecord } | { type: "dismissed"; jobKey: string; revision: number };
export interface NativeJobView { baseline: number; jobs: ReadonlyMap<string, NativeJobRecord>; tombstones: ReadonlyMap<string, number>; needsSnapshot: boolean }
const states = new Set(["accepting", "running", "recovering", "needs_attention", "completed", "error", "cancelled", "discarded"]);
const safe = (v: unknown, positive = false): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= (positive ? 1 : 0);
const id = (v: unknown, limit = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= limit && /^[A-Za-z0-9._:-]+$/.test(v);
const key = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{48}$/.test(v);
const bytes = (v: unknown, limit: number): v is string => typeof v === "string" && v.length <= limit && new TextEncoder().encode(v).length <= limit && !v.includes("\0");
const windowLabel = (v: unknown): v is string => typeof v === "string" && /^[!-~]{1,128}$/.test(v);
export const nativeJobTerminal = (state: NativeJobState): boolean => ["completed", "error", "cancelled", "discarded"].includes(state);
export function validNativeJob(value: unknown): value is NativeJobRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as NativeJobRecord;
  return key(r.jobKey) && !!r.owner && id(r.owner.packageId, 256) && /^[a-f0-9]{64}$/.test(r.owner.digest) && safe(r.owner.incarnation, true)
    && id(r.operationId) && id(r.kind) && safe(r.jobId, true) && safe(r.revision, true)
    && (r.sourceRevision === undefined || safe(r.sourceRevision)) && safe(r.createdAtMs) && safe(r.updatedAtMs)
    && typeof r.label === "string" && !!r.label && Array.from(r.label).length <= 256 && !/\p{Cc}/u.test(r.label)
    && windowLabel(r.originWindow) && states.has(r.state)
    && (r.phase == null || bytes(r.phase, 128)) && (r.error == null || bytes(r.error, 2048))
    && (r.outputPath == null || bytes(r.outputPath, 4096)) && (r.runId == null || safe(r.runId, true));
}
export function validNativeSnapshot(value: unknown): value is NativeJobSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as NativeJobSnapshot;
  if (!windowLabel(s.originWindow) || !safe(s.watermark) || !Array.isArray(s.jobs) || s.jobs.length > 384) return false;
  const keys = new Set<string>(), ids = new Set<number>(), operations = new Set<string>();
  for (const r of s.jobs) {
    if (!validNativeJob(r) || r.revision > s.watermark || keys.has(r.jobKey) || ids.has(r.jobId)) return false;
    const operation = `${r.owner.packageId}:${r.operationId}`;
    if (operations.has(operation)) return false;
    keys.add(r.jobKey); ids.add(r.jobId); operations.add(operation);
  }
  return true;
}
export function validNativeEvent(value: unknown): value is NativeJobEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as NativeJobEvent;
  return e.type === "updated" ? validNativeJob(e.job) : e.type === "dismissed" && key(e.jobKey) && safe(e.revision, true);
}
export const emptyNativeJobs = (): NativeJobView => ({ baseline: 0, jobs: new Map(), tombstones: new Map(), needsSnapshot: false });
export function adoptNativeSnapshot(old: NativeJobView, snapshot: NativeJobSnapshot): NativeJobView {
  const observed = Math.max(old.baseline, ...[...old.jobs.values()].map((r) => r.revision), ...old.tombstones.values());
  if (snapshot.watermark < observed) return old;
  return { baseline: snapshot.watermark, jobs: new Map(snapshot.jobs.map((r) => [r.jobKey, r])), tombstones: new Map(), needsSnapshot: false };
}
function sameIdentity(a: NativeJobRecord, b: NativeJobRecord): boolean {
  return a.jobKey === b.jobKey && a.jobId === b.jobId && a.kind === b.kind && a.operationId === b.operationId
    && a.owner.packageId === b.owner.packageId && a.owner.digest === b.owner.digest && a.owner.incarnation === b.owner.incarnation
    && a.originWindow === b.originWindow && a.createdAtMs === b.createdAtMs;
}
export function mergeNativeJobEvent(old: NativeJobView, event: NativeJobEvent): NativeJobView {
  const jobKey = event.type === "updated" ? event.job.jobKey : event.jobKey;
  const revision = event.type === "updated" ? event.job.revision : event.revision;
  if (revision <= old.baseline || revision <= (old.tombstones.get(jobKey) ?? 0) || revision <= (old.jobs.get(jobKey)?.revision ?? 0)) return old;
  const jobs = new Map(old.jobs), tombstones = new Map(old.tombstones);
  if (event.type === "dismissed") {
    const previous = jobs.get(jobKey);
    if (previous && !nativeJobTerminal(previous.state)) return old;
    jobs.delete(jobKey); tombstones.set(jobKey, revision);
  } else {
    const previous = jobs.get(jobKey);
    if (previous && (!sameIdentity(previous, event.job) || nativeJobTerminal(previous.state) && previous.state !== event.job.state)) return old;
    if ([...jobs.values()].some((r) => r.jobKey !== jobKey && (r.jobId === event.job.jobId || r.owner.packageId === event.job.owner.packageId && r.operationId === event.job.operationId))) return old;
    if (!previous && !nativeJobTerminal(event.job.state) && [...jobs.values()].filter((r) => !nativeJobTerminal(r.state)).length >= 128) return old;
    jobs.set(jobKey, event.job);
    const finished = [...jobs.values()].filter((r) => nativeJobTerminal(r.state)).sort((a, b) => a.revision - b.revision);
    for (const record of finished.slice(0, Math.max(0, finished.length - 256))) { jobs.delete(record.jobKey); tombstones.set(record.jobKey, record.revision); }
  }
  let baseline = old.baseline;
  let needsSnapshot = old.needsSnapshot;
  if (tombstones.size > 1024) {
    const oldest = [...tombstones].sort((a, b) => a[1] - b[1]).slice(0, tombstones.size - 1024);
    for (const [key, revision] of oldest) { tombstones.delete(key); baseline = Math.max(baseline, revision); }
    needsSnapshot = true;
  }
  return { jobs, tombstones, baseline, needsSnapshot };
}
export function jobStateLabel(state: NativeJobState): string {
  return ({ accepting: "Preparing", running: "Generating", recovering: "Recovering original operation", needs_attention: "Needs attention — outcome or delivery requires recovery", completed: "Complete", error: "Failed", cancelled: "Cancelled", discarded: "Discarded" })[state];
}
