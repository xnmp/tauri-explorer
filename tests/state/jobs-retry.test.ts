/**
 * Retrying a failed background job (plugin SDK capability "jobRetry"): the
 * job's `retry` starts the replacement; the store removes the failed entry on
 * success and keeps it, with the new error, otherwise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isJobActive, jobsStore, type JobRetry } from "$lib/state/jobs.svelte";

afterEach(() => { for (const job of [...jobsStore.jobs]) jobsStore.removeJob(job.id); });

const find = (id: number, status?: string) => jobsStore.jobs.find((job) => job.id === id && (!status || job.status === status));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function failedJob(id: number, retry?: JobRetry) {
  jobsStore.addJob(id, "lantern.png", "Make it daytime", "trace", "image", { retry });
  jobsStore.failJob(id, "Codex replied with a refusal");
}

describe("jobsStore.retryJob", () => {
  it("calls retry once and marks the entry retrying until it settles", async () => {
    const start = deferred<{ ok: true; data: number }>();
    const retry = vi.fn(() => start.promise);
    failedJob(10, retry);

    const first = jobsStore.retryJob(10);
    expect(find(10)?.retrying).toBe(true);
    // A second click while starting does not submit again.
    const second = jobsStore.retryJob(10);
    expect(retry).toHaveBeenCalledTimes(1);

    jobsStore.addJob(11, "lantern.png", "Make it daytime", "trace", "image", { retry });
    start.resolve({ ok: true, data: 11 });
    await Promise.all([first, second]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("removes the failed entry and keeps the new job on success", async () => {
    const retry = vi.fn<JobRetry>(async () => {
      jobsStore.addJob(21, "lantern.png", "Make it daytime", "trace", "image");
      return { ok: true, data: 21 };
    });
    failedJob(20, retry);
    await jobsStore.retryJob(20);
    expect(find(20)).toBeUndefined();
    expect(find(21)?.status).toBe("running");
  });

  it("only removes the failed entry when the new job reuses its id", async () => {
    failedJob(30, async () => {
      jobsStore.addJob(30, "other.png", "another kind", "upscale", "image");
      return { ok: true, data: 30 };
    });
    await jobsStore.retryJob(30);
    expect(jobsStore.jobs.filter((job) => job.id === 30).map((job) => job.status)).toEqual(["running"]);
  });

  it("keeps the entry and shows a returned error", async () => {
    const retry = vi.fn<JobRetry>(async () => ({ ok: false, error: "Rate limited" }));
    failedJob(40, retry);
    await jobsStore.retryJob(40);
    expect(find(40)).toMatchObject({ status: "error", error: "Rate limited", retrying: false });
    // It can be retried again.
    await jobsStore.retryJob(40);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("keeps the entry and shows a rejection or a malformed result", async () => {
    failedJob(50, async () => { throw new Error("Plugin is disabled"); });
    await jobsStore.retryJob(50);
    expect(find(50)).toMatchObject({ status: "error", error: "Plugin is disabled", retrying: false });

    failedJob(51, (() => { throw "boom"; }) as unknown as JobRetry);
    await jobsStore.retryJob(51);
    expect(find(51)).toMatchObject({ status: "error", error: "boom" });

    failedJob(52, (async () => undefined) as unknown as JobRetry);
    await jobsStore.retryJob(52);
    expect(find(52)).toMatchObject({ status: "error", error: "Retry failed" });
  });

  it("does nothing for jobs without retry, or that have not failed", async () => {
    failedJob(60);
    await jobsStore.retryJob(60);
    expect(find(60)).toMatchObject({ status: "error", error: "Codex replied with a refusal" });

    const retry = vi.fn<JobRetry>(async () => ({ ok: true, data: 99 }));
    jobsStore.addJob(61, "a.png", "running", "trace", "image", { retry });
    jobsStore.addJob(62, "b.png", "done", "trace", "image", { retry });
    jobsStore.completeJob(62, "/out/b.png");
    await jobsStore.retryJob(61);
    await jobsStore.retryJob(62);
    await jobsStore.retryJob(404);
    expect(retry).not.toHaveBeenCalled();
    expect(find(61)?.status).toBe("running");
    expect(find(62)?.status).toBe("completed");
  });

  it("resolves to the replacement job's id, or null when the retry fails", async () => {
    failedJob(80, async () => ({ ok: true, data: 81 }));
    expect(await jobsStore.retryJob(80)).toBe(81);
    failedJob(82, async () => ({ ok: false, error: "no" }));
    expect(await jobsStore.retryJob(82)).toBeNull();
  });

  it("keeps an entry whose retry is starting: it cannot be dismissed or cleared", async () => {
    const start = deferred<{ ok: false; error: string }>();
    failedJob(90, () => start.promise);
    jobsStore.addJob(91, "done.png", "d", "trace", "image");
    jobsStore.failJob(91, "refused");
    const retrying = jobsStore.retryJob(90);
    expect(isJobActive(find(90)!)).toBe(true);

    jobsStore.dismissJob(90);
    jobsStore.clearCompleted();
    expect(find(90)?.retrying).toBe(true);
    expect(find(91)).toBeUndefined();

    // So a failure after the click still lands on its entry.
    start.resolve({ ok: false, error: "Rate limited" });
    await retrying;
    expect(find(90)).toMatchObject({ status: "error", error: "Rate limited", retrying: false });
    expect(isJobActive(find(90)!)).toBe(false);
    jobsStore.dismissJob(90);
    expect(find(90)).toBeUndefined();
  });

  it("dismisses finished entries but never running ones", () => {
    jobsStore.addJob(95, "a.png", "d");
    jobsStore.dismissJob(95);
    expect(find(95)?.status).toBe("running");
  });

  it("drops Retry only from the retired plugin's entries", () => {
    const retry: JobRetry = async () => ({ ok: true, data: 0 });
    jobsStore.addJob(96, "a.png", "d", "trace-image", "image", { owner: "trace", retry });
    jobsStore.addJob(97, "b.png", "d", "other-image", "image", { owner: "other", retry });
    jobsStore.dropRetries("trace");
    expect(find(96)?.retry).toBeUndefined();
    expect(find(97)?.retry).toBe(retry);
  });

  it("ignores a retry that is not a function, and a malformed owner", () => {
    failedJob(70, "not a function" as unknown as JobRetry);
    expect(find(70)?.retry).toBeUndefined();
    jobsStore.addJob(71, "a.png", "d", "trace", "image", { owner: 5 as unknown as string });
    expect(find(71)?.owner).toBeUndefined();
  });
});
