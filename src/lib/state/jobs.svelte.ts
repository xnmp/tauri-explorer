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
  /** The plugin that started the job; its retirement drops `retry`. */
  owner?: string;
  /** Offered as a Retry action once the job fails. */
  retry?: JobRetry;
  /** A retry is starting; its action is disabled until it settles. */
  retrying?: boolean;
}

export interface JobExtras {
  owner?: string;
  retry?: JobRetry;
}

/** Running, or a failed job whose retry is starting: not dismissable, and
 *  it keeps Background Operations open. */
export function isJobActive(job: Job): boolean {
  return job.status === "running" || job.retrying === true;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" && error ? error : "Retry failed";
}

function createJobsStore() {
  let jobs = $state<Job[]>([]);

  function addJob(id: number, label: string, detail: string, source: string = "app", presentation?: "image", extras: JobExtras = {}): void {
    const job: Job = { id, label, detail, source, presentation, status: "running", startTime: Date.now() };
    if (typeof extras.owner === "string") job.owner = extras.owner;
    if (typeof extras.retry === "function") job.retry = extras.retry;
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

  /** Remove finished jobs, keeping running ones and retries in progress. */
  function clearCompleted(): void {
    jobs = jobs.filter(isJobActive);
  }

  /** The user dismissing a finished entry; running jobs and retries in
   *  progress stay. */
  function dismissJob(id: number): void {
    jobs = jobs.filter((j) => j.id !== id || isJobActive(j));
  }

  /** A retired plugin's jobs stop offering Retry (its code must not run). */
  function dropRetries(owner: string): void {
    if (!jobs.some((j) => j.owner === owner && j.retry)) return;
    jobs = jobs.map((j) => {
      if (j.owner !== owner || !j.retry) return j;
      const { retry: _retry, ...rest } = j;
      return rest;
    });
  }

  const isFailed = (job: Job, id: number) => job.id === id && job.status === "error";

  /**
   * Retry a failed job through its `retry`. The retry starts the replacement
   * job itself; on success the failed entry is removed, otherwise the
   * rejection or `{ ok: false }` error replaces the entry's error and the
   * entry stays (if it still exists). A retry already starting, a job
   * without `retry`, or one that has not failed is left alone. Resolves to
   * the replacement job's id on success, else null.
   */
  async function retryJob(id: number): Promise<number | null> {
    const job = jobs.find((candidate) => isFailed(candidate, id));
    if (!job?.retry || job.retrying) return null;
    const retry = job.retry;
    jobs = jobs.map((j) => (isFailed(j, id) ? { ...j, retrying: true } : j));
    let error: string | null;
    let replacement: number | null = null;
    try {
      const result = await retry();
      error = result?.ok === true ? null : describeError(result?.error);
      if (result?.ok === true && typeof result.data === "number") replacement = result.data;
    } catch (thrown) {
      error = describeError(thrown);
    }
    // Only the failed entry: a replacement may reuse its id under another kind.
    jobs = error === null
      ? jobs.filter((j) => !isFailed(j, id))
      : jobs.map((j) => (isFailed(j, id) ? { ...j, retrying: false, error } : j));
    return error === null ? replacement : null;
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
    dismissJob,
    dropRetries,
    removeJob,
    retryJob,
  };
}

export const jobsStore = createJobsStore();
