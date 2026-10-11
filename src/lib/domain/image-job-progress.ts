import { nativeJobSettled, type NativeJobState } from "./native-plugin-jobs";

export interface ImageJobTiming {
  readonly source: string;
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

/** An elapsed-time estimate, never provider-reported progress. */
export function imageJobProgress(job: ImageJobTiming, history: readonly ImageJobTiming[], now: number) {
  const durations = history.filter(item => item !== job && item.presentation === "image" && item.source === job.source && item.status === "completed")
    .map(item => (item.endTime ?? NaN) - item.startTime)
    .filter(duration => Number.isFinite(duration) && duration >= 1000 && duration <= 3_600_000)
    .slice(-20).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const expectedMs = durations.length ? durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2 : 120_000;
  const elapsedMs = jobDuration(job, now);
  const known = elapsedMs ?? 0;
  return {
    /** Null when a settled job's end was never recorded. */
    elapsedMs,
    percent: job.status === "completed" ? 100 : Math.min(95, Math.floor(known / expectedMs * 100)),
    remainingMs: Math.max(0, expectedMs - known),
    overdue: known >= expectedMs,
  };
}

export function formatJobDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
