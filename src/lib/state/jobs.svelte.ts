/**
 * Background jobs state management.
 * Issue: feat/nano-banana
 *
 * Tracks long-running background operations (e.g. Nano Banana image edits)
 * with status, elapsed time, and output info.
 */

export type JobStatus = "running" | "completed" | "error";

export interface Job {
  id: number;
  label: string;
  /** Free-text detail line (e.g. the Nano Banana prompt). */
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
  };
}

export const jobsStore = createJobsStore();
