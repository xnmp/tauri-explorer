/**
 * Background Operations' Retry action (capability "jobRetry"): offered only
 * on failed jobs that carry `retry`, and disabled while a retry is starting.
 * Rendered with Svelte's server renderer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import ProgressDialog from "$lib/components/ProgressDialog.svelte";
import JobsPanel from "$lib/components/JobsPanel.svelte";
import { jobsStore, type JobRetry } from "$lib/state/jobs.svelte";

afterEach(() => { for (const job of [...jobsStore.jobs]) jobsStore.removeJob(job.id); });

const retry: JobRetry = () => new Promise(() => {});

function seed(): void {
  jobsStore.addJob(1, "with-retry.png", "d", "trace", "image", retry);
  jobsStore.failJob(1, "refused");
  jobsStore.addJob(2, "no-retry.png", "d", "trace", "image");
  jobsStore.failJob(2, "refused");
  jobsStore.addJob(3, "running.png", "d", "trace", "image", retry);
  jobsStore.addJob(4, "done.png", "d", "trace", "image", retry);
  jobsStore.completeJob(4, "/out/done.png");
}

/** The opening tag of each button whose aria-label starts with "Retry ". */
const retryButtons = (html: string) => html.match(/<button[^>]*aria-label="Retry [^"]*"[^>]*>/g) ?? [];

describe.each([
  ["Image generation panel", () => render(ProgressDialog as never, {} as never).body],
  ["Background Jobs panel", () => render(JobsPanel as never, { props: { open: true, onClose() {} } } as never).body],
])("%s", (_name, html) => {
  it("offers Retry only on failed jobs with retry", () => {
    seed();
    const buttons = retryButtons(html());
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('aria-label="Retry with-retry.png"');
    expect(buttons[0]).not.toMatch(/\sdisabled/);
  });

  it("disables Retry while the retry is starting", async () => {
    seed();
    const pending = jobsStore.retryJob(1);
    const [button] = retryButtons(html());
    expect(button).toMatch(/\sdisabled/);
    expect(button).toContain('aria-busy="true"');
    void pending;
  });

  it("shows no Retry without failed retryable jobs", () => {
    jobsStore.addJob(5, "plain.png", "d", "trace", "image");
    jobsStore.failJob(5, "refused");
    expect(retryButtons(html())).toEqual([]);
  });
});
