import { nativeJobSettled, type NativeJobState } from "./native-plugin-jobs";

export interface ImageJobTiming {
  readonly source: string;
  readonly estimateKey?: string | null;
  readonly status: string;
  readonly phase?: string | null;
  readonly presentation?: "image";
  readonly startTime: number;
  readonly endTime?: number;
}

/** A job is settled once it is terminal or parked by Stop/Discard. */
export function isTimingSettled(job: Pick<ImageJobTiming, "status" | "phase">): boolean {
  return nativeJobSettled({ state: job.status as NativeJobState, phase: job.phase });
}

/**
 * How long a job has run: now - start while it is active, and the frozen
 * end - start once it is settled. A settled job with no recorded end (it
 * settled before the host recorded one) has no known duration: null, never
 * a figure that keeps growing. Clock skew clamps to 0.
 */
export function jobDuration(job: ImageJobTiming, now: number): number | null {
  if (!Number.isFinite(job.startTime)) return null;
  const end = isTimingSettled(job) ? job.endTime : now;
  return typeof end === "number" && Number.isFinite(end) ? Math.max(0, end - job.startTime) : null;
}

const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const SAMPLE_LIMIT = 20;
const MIN_SAMPLES = 3;
const DEFAULT_MS = 120_000;

function medianDuration(samples: readonly ImageJobTiming[]): number | null {
  if (samples.length < MIN_SAMPLES) return null;
  const durations = [...samples].sort((a, b) => a.endTime! - b.endTime!).slice(-SAMPLE_LIMIT)
    .map(item => item.endTime! - item.startTime).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  return durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
}

/** Successful, bounded samples only; keyed history → source history → default.
 * Completion time defines recency, independent of revisions or array order. */
export function estimatedImageDuration(job: ImageJobTiming, history: readonly ImageJobTiming[], now: number): number {
  const samples = history.filter(item => item !== job && item.presentation === "image" && item.source === job.source && item.status === "completed"
    && timestamp(item.startTime) && timestamp(item.endTime) && item.endTime <= now
    && item.endTime - item.startTime >= 1000 && item.endTime - item.startTime <= 3_600_000);
  const keyed = job.estimateKey ? medianDuration(samples.filter(item => item.estimateKey === job.estimateKey)) : null;
  return keyed ?? medianDuration(samples) ?? DEFAULT_MS;
}

/** An elapsed-time estimate, never provider-reported progress. */
export function imageJobProgress(job: ImageJobTiming, history: readonly ImageJobTiming[], now: number) {
  const expectedMs = estimatedImageDuration(job, history, now);
  const elapsedMs = jobDuration(job, now);
  const known = elapsedMs ?? 0;
  return {
    expectedMs,
    /** Null when a settled job's end was never recorded. */
    elapsedMs,
    percent: job.status === "completed" ? 100 : Math.min(95, Math.floor(known / expectedMs * 100)),
    remainingMs: Math.max(0, expectedMs - known),
    overdue: known >= expectedMs,
  };
}

export function imageJobEstimateLabel(timing: ReturnType<typeof imageJobProgress>): string {
  return timing.overdue ? "Estimate · longer than usual" : `Estimate · ~${formatJobDuration(timing.remainingMs)} remaining`;
}

export function formatJobDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
