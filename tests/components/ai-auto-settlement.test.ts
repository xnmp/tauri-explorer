import { afterEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import JobsPanel from "$lib/components/JobsPanel.svelte";
import ProgressDialog from "$lib/components/ProgressDialog.svelte";
import PluginsDialog from "$lib/components/PluginsDialog.svelte";
import { jobsStore } from "$lib/state/jobs.svelte";
import type { NativeJobRecord } from "$lib/domain/native-plugin-jobs";

const job = (state: NativeJobRecord["state"], error?: string): NativeJobRecord => ({
  jobKey: "a".repeat(48), owner: { packageId: "consumer", digest: "b".repeat(64), incarnation: 1 },
  operationId: "original", jobId: 9100, kind: "openai-image", label: "output.png", originWindow: "main",
  revision: 1, createdAtMs: 1, updatedAtMs: 2, settledAtMs: state === "running" ? undefined : 2,
  state, phase: state === "needs_attention" ? "stopped" : undefined, error,
});
const panels = () => [
  render(JobsPanel as never, { props: { open: true, onClose() {} } } as never).body,
  render(ProgressDialog as never, {} as never).body,
];
afterEach(() => { jobsStore.applyNative([]); for (const job of [...jobsStore.jobs]) jobsStore.removeJob(job.id); });

describe("automatic AI settlement presentation", () => {
  it.each(["running", "needs_attention", "discarded"] as const)("never asks users to resolve a %s job", state => {
    jobsStore.applyNative([job(state)]);
    for (const html of panels()) expect(html).not.toMatch(/unresolved|Inspect operation|>Inspect</i);
    expect(render(PluginsDialog as never, { props: { open: true, onClose() {} } } as never).body).not.toMatch(/unresolved/i);
  });
  it.each(["discarded", "error"] as const)("shows a %s job's reason exactly once in each normal job surface", state => {
    const reason = "Provider connection closed before its outcome was known";
    jobsStore.applyNative([job(state, reason)]);
    for (const html of panels()) expect(html.split(reason)).toHaveLength(2);
  });
  it("retains cancellation for an active job", () => {
    jobsStore.applyNative([job("running")]);
    for (const html of panels()) expect(html).toContain('aria-label="Cancel output.png"');
  });
});
