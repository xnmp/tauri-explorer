/**
 * Jobs store: generalized detail/source shape (src/lib/state/jobs.svelte.ts).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { jobsStore } from "$lib/state/jobs.svelte";

describe("jobsStore", () => {
  beforeEach(() => {
    jobsStore.clearCompleted();
    // Fail then clear any leftover running jobs from prior tests.
    for (const j of jobsStore.jobs) jobsStore.failJob(j.id, "reset");
    jobsStore.clearCompleted();
  });

  it("adds a job with detail and a default source of 'app'", () => {
    jobsStore.addJob(1, "Label", "some detail");
    const job = jobsStore.jobs.find((j) => j.id === 1)!;
    expect(job.detail).toBe("some detail");
    expect(job.source).toBe("app");
    expect(job.status).toBe("running");
  });

  it("records an explicit source (e.g. a plugin id)", () => {
    jobsStore.addJob(2, "Plugin Job", "detail", "demo");
    expect(jobsStore.jobs.find((j) => j.id === 2)!.source).toBe("demo");
  });

  it("completes and fails jobs by id", () => {
    jobsStore.addJob(3, "A", "d");
    jobsStore.addJob(4, "B", "d");
    jobsStore.completeJob(3, "/out/a.png");
    jobsStore.failJob(4, "boom");
    expect(jobsStore.jobs.find((j) => j.id === 3)!.status).toBe("completed");
    expect(jobsStore.jobs.find((j) => j.id === 3)!.outputPath).toBe("/out/a.png");
    expect(jobsStore.jobs.find((j) => j.id === 4)!.status).toBe("error");
    expect(jobsStore.jobs.find((j) => j.id === 4)!.error).toBe("boom");
  });

  it("clearCompleted keeps only running jobs", () => {
    jobsStore.addJob(5, "R", "d");
    jobsStore.addJob(6, "C", "d");
    jobsStore.completeJob(6, "/out.png");
    jobsStore.clearCompleted();
    expect(jobsStore.jobs.some((j) => j.id === 5)).toBe(true);
    expect(jobsStore.jobs.some((j) => j.id === 6)).toBe(false);
  });
});
