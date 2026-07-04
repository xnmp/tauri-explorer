/**
 * Background jobs state management.
 *
 * Tracks long-running background operations (built-in flows or plugin jobs,
 * e.g. AI image edits) with status, elapsed time, and output info.
 */

export type JobStatus = "running" | "completed" | "error";

export interface Job {
  id: number;
  label: string;
  /** Free-text detail line (e.g. an edit prompt). */
  detail: string;
  /** Origin of the job: "app" for built-in flows, or a plugin id. */
  source: string;
  status: JobStatus;
  error?: string;
  startTime: number;
  endTime?: number;
  outputPath?: string;
}

function createJobsStore() {
  let jobs = $state<Job[]>([]);

  function addJob(id: number, label: string, detail: string, source: string = "app"): void {
    jobs = [...jobs, { id, label, detail, source, status: "running", startTime: Date.now() }];
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
  };
}

export const jobsStore = createJobsStore();
