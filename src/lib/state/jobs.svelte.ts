/**
 * Background jobs state management.
 *
 * Tracks long-running background operations (built-in flows or plugin jobs,
 * e.g. AI image edits) with status, elapsed time, and output info.
 */

import { nativeJobSettled, nativeJobTerminal, type NativeJobRecord, type NativeJobState } from "$lib/domain/native-plugin-jobs";
export type JobStatus = NativeJobState;

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
  /** Stable native package authority, separate from the contribution owning Retry. */
  nativePackageOwner?: string;
  /** Offered as a Retry action once the job fails. */
  retry?: JobRetry;
  /** A retry is starting; its action is disabled until it settles. */
  retrying?: boolean;
  jobKey?: string;
  revision?: number;
  phase?: string;
  controlPending?: "cancel" | "dismiss" | "resume";
  controlError?: string;
  cancelRequested?: boolean;
}

export interface JobExtras {
  owner?: string;
  retry?: JobRetry;
  nativeOwner?: string;
}

/** Running, or a failed job whose retry is starting: not dismissable, and
 *  it keeps Background Operations open. A stopped or discarded recovery is
 *  settled: its evidence stays in Unresolved AI operations. */
export function isJobActive(job: Job): boolean {
  return !nativeJobSettled({ state: job.status, phase: job.phase }) || job.retrying === true || !!job.controlPending;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" && error ? error : "Retry failed";
}

function createJobsStore() {
  let jobs = $state<Job[]>([]);
  let monitoringError = $state<string | null>(null);
  let nativeControls: { cancel(key: string): Promise<void>; dismiss(key: string): Promise<void>; resume(key: string): Promise<void>; refresh?(): Promise<void> } | null = null;

  function addJob(id: number, label: string, detail: string, source: string = "app", presentation?: "image", extras: JobExtras = {}): void {
    const packageOwner = extras.nativeOwner;
    const existing = jobs.find((job) => job.id === id && job.jobKey && job.source === source && job.nativePackageOwner === packageOwner);
    if (existing) {
      jobs = jobs.map((job) => job === existing ? { ...job, owner: extras.owner ?? job.owner, detail, retry: typeof extras.retry === "function" ? extras.retry : job.retry } : job);
      return;
    }
    if (jobs.some((job) => job.id === id && job.jobKey)) return;
    const job: Job = { id, label, detail, source, presentation, status: "running", startTime: Date.now() };
    if (typeof extras.owner === "string") job.owner = extras.owner;
    if (typeof extras.nativeOwner === "string") job.nativePackageOwner = extras.nativeOwner;
    if (typeof extras.retry === "function") job.retry = extras.retry;
    jobs = [...jobs, job];
  }

  function completeJob(id: number, outputPath: string): void {
    jobs = jobs.map((j) =>
      j.id === id && !j.jobKey ? { ...j, status: "completed" as const, endTime: Date.now(), outputPath } : j
    );
  }

  function failJob(id: number, error: string): void {
    jobs = jobs.map((j) =>
      j.id === id && !j.jobKey ? { ...j, status: "error" as const, endTime: Date.now(), error } : j
    );
  }

  /** Remove finished jobs, keeping running ones and retries in progress. */
  function clearCompleted(): void {
    for (const job of jobs.filter((job) => job.jobKey && !isJobActive(job))) void controlJob(job.id, "dismiss");
    jobs = jobs.filter((job) => !!job.jobKey || isJobActive(job));
  }

  /** The user dismissing a finished entry; running jobs and retries in
   *  progress stay. */
  function dismissJob(id: number): void {
    if (jobs.some((job) => job.id === id && job.jobKey)) { void controlJob(id, "dismiss"); return; }
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
  function applyNative(records: readonly NativeJobRecord[]): void {
    const legacy = jobs.filter((job) => !job.jobKey && !records.some((r) => r.jobId === job.id));
    const next = records.map((r): Job => {
      const previous = jobs.find((job) => job.jobKey === r.jobKey || !job.jobKey && job.id === r.jobId && job.source === r.kind && job.nativePackageOwner === r.owner.packageId);
      const terminal = nativeJobSettled(r);
      return { id: r.jobId, jobKey: r.jobKey, revision: r.revision, owner: previous?.owner ?? r.owner.packageId, nativePackageOwner: r.owner.packageId, source: r.kind, label: r.label,
        detail: previous?.detail ?? "", presentation: "image", status: r.state, startTime: r.createdAtMs,
        ...(terminal ? { endTime: r.updatedAtMs } : {}), outputPath: r.outputPath ?? undefined, error: r.error ?? undefined, phase: r.phase ?? undefined,
        retry: previous?.retry, retrying: previous?.retrying,
        controlPending: terminal ? undefined : previous?.controlPending, controlError: previous?.controlError,
        cancelRequested: terminal ? false : previous?.cancelRequested };
    });
    jobs = [...legacy, ...next];
  }
  async function controlJob(id: number, action: "cancel" | "dismiss" | "resume"): Promise<void> {
    const job = jobs.find((job) => job.id === id && job.jobKey);
    if (!job?.jobKey || !nativeControls || job.controlPending || job.retrying
      || action === "dismiss" && isJobActive(job) || action === "cancel" && nativeJobTerminal(job.status)) return;
    const key = job.jobKey;
    jobs = jobs.map((j) => j.jobKey === key ? { ...j, controlPending: action, controlError: undefined } : j);
    try {
      await nativeControls[action](key);
      if (action === "cancel") jobs = jobs.map((j) => j.jobKey === key && !nativeJobTerminal(j.status) ? { ...j, cancelRequested: true } : j);
    } catch (failure) {
      jobs = jobs.map((j) => j.jobKey === key ? { ...j, controlError: describeError(failure) } : j);
    } finally { jobs = jobs.map((j) => j.jobKey === key ? { ...j, controlPending: undefined } : j); }
  }

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
    if (job.jobKey) {
      jobs = jobs.map((j) => j.jobKey === job.jobKey ? { ...j, retrying: false, controlError: error ?? undefined } : j);
      if (error === null) await controlJob(id, "dismiss");
    } else jobs = error === null ? jobs.filter((j) => !isFailed(j, id)) : jobs.map((j) => (isFailed(j, id) ? { ...j, retrying: false, error } : j));
    return error === null ? replacement : null;
  }

  /** Remove a job outright by id (e.g. orphan teardown on plugin dispose). */
  function removeJob(id: number): void {
    jobs = jobs.filter((j) => j.id !== id || !!j.jobKey);
  }

  return {
    get jobs() {
      return jobs;
    },
    get hasRunningJobs() {
      return jobs.some(isJobActive);
    },
    get runningCount() {
      return jobs.filter(isJobActive).length;
    },
    get monitoringError() { return monitoringError; },
    setMonitoringError(value: string | null): void { monitoringError = value; },
    configureNativeControls(value: typeof nativeControls): void { nativeControls = value; },
    applyNative,
    controlJob,
    refreshNative: () => nativeControls?.refresh?.() ?? Promise.resolve(),
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
