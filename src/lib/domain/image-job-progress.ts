export interface ImageJobTiming {
  readonly source: string;
  readonly status: string;
  readonly presentation?: "image";
  readonly startTime: number;
  readonly endTime?: number;
}

/** An elapsed-time estimate, never provider-reported progress. */
export function imageJobProgress(job: ImageJobTiming, history: readonly ImageJobTiming[], now: number) {
  const durations = history.filter(item => item !== job && item.presentation === "image" && item.source === job.source && item.status === "completed")
    .map(item => (item.endTime ?? NaN) - item.startTime)
    .filter(duration => Number.isFinite(duration) && duration >= 1000 && duration <= 3_600_000)
    .slice(-20).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const expectedMs = durations.length ? durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2 : 120_000;
  const duration = (job.endTime ?? now) - job.startTime;
  const elapsedMs = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  return {
    elapsedMs,
    percent: job.status === "completed" ? 100 : Math.min(95, Math.floor(elapsedMs / expectedMs * 100)),
    remainingMs: Math.max(0, expectedMs - elapsedMs),
    overdue: elapsedMs >= expectedMs,
  };
}

export function formatJobDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
