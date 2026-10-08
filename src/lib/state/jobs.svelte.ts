/**
 * Background jobs state management.
 *
 * Tracks long-running background operations (built-in flows or plugin jobs,
 * e.g. AI image edits) with status, elapsed time, and output info.
 */

export type JobStatus = "running" | "completed" | "error";

/** Starts a replacement for a failed job (a plugin's `accept` result). */
export type JobRetry = () => Promise<{ ok: true; data: number } | { ok: false; error: string }>;

export interface Job {
  id: number;
  label: string;
  /** Free-text detail line (e.g. an edit prompt). */
  detail: string;
  /** Origin of the job: "app" for built-in flows, or a plugin id. */
  source: string;
  presentation?: "image";
  status: JobStatus;
  error?: string;
  startTime: number;
  endTime?: number;
  outputPath?: string;
  /** Offered as a Retry action once the job fails. */
  retry?: JobRetry;
  /** A retry is starting; its action is disabled until it settles. */
  retrying?: boolean;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" && error ? error : "Retry failed";
}

function createJobsStore() {
  let jobs = $state<Job[]>([]);

  function addJob(id: number, label: string, detail: string, source: string = "app", presentation?: "image", retry?: JobRetry): void {
    const job: Job = { id, label, detail, source, presentation, status: "running", startTime: Date.now() };
    if (typeof retry === "function") job.retry = retry;
    jobs = [...jobs, job];
  }

  function completeJob(id: number, outputPath: string): void {
    jobs = jobs.map((j) =>
      j.id === id ? { ...j, status: "completed" as const, endTime: Date.now(), outputPath } : j
    );
  }

  function failJob(id: number, error: string): void {
    jobs = jobs.map((j) =>
      j.id === id ? { ...j, status: "error" as const, endTime: Date.now(), error } : j
    );
  }

  function clearCompleted(): void {
    jobs = jobs.filter((j) => j.status === "running");
  }

  const isFailed = (job: Job, id: number) => job.id === id && job.status === "error";

  /**
   * Retry a failed job through its `retry`. The retry starts the replacement
   * job itself; on success the failed entry is removed, otherwise the
   * rejection or `{ ok: false }` error replaces the entry's error and the
   * entry stays. A retry already starting, a job without `retry`, or one
   * that has not failed is left alone.
   */
  async function retryJob(id: number): Promise<void> {
    const job = jobs.find((candidate) => isFailed(candidate, id));
    if (!job?.retry || job.retrying) return;
    const retry = job.retry;
    jobs = jobs.map((j) => (isFailed(j, id) ? { ...j, retrying: true } : j));
    let error: string | null;
    try {
      const result = await retry();
      error = result?.ok === true ? null : describeError(result?.error);
    } catch (thrown) {
      error = describeError(thrown);
    }
    // Only the failed entry: a replacement may reuse its id under another kind.
    jobs = error === null
      ? jobs.filter((j) => !isFailed(j, id))
      : jobs.map((j) => (isFailed(j, id) ? { ...j, retrying: false, error } : j));
  }

  /** Remove a job outright by id (e.g. orphan teardown on plugin dispose). */
  function removeJob(id: number): void {
    jobs = jobs.filter((j) => j.id !== id);
  }

  return {
    get jobs() {
      return jobs;
    },
    get hasRunningJobs() {
      return jobs.some((j) => j.status === "running");
    },
    get runningCount() {
      return jobs.filter((j) => j.status === "running").length;
    },
    addJob,
    completeJob,
    failJob,
    clearCompleted,
    removeJob,
    retryJob,
  };
}

export const jobsStore = createJobsStore();
