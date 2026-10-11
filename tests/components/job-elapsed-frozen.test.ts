/**
 * A settled job's elapsed time is frozen at its settled time; an active one
 * follows the clock. Rendered with Svelte's server renderer under a
 * controllable system clock, so a later render stands for "minutes later".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import ProgressDialog from "$lib/components/ProgressDialog.svelte";
import JobsPanel from "$lib/components/JobsPanel.svelte";
import { jobsStore } from "$lib/state/jobs.svelte";
import type { NativeJobRecord } from "$lib/domain/native-plugin-jobs";

const START = Date.UTC(2026, 0, 1);
const record = (n: number, state: NativeJobRecord["state"], extra: Partial<NativeJobRecord> = {}): NativeJobRecord => ({
  jobKey: n.toString(16).padStart(48, "0"), owner: { packageId: "consumer", digest: "a".repeat(64), incarnation: 3 },
  operationId: `operation-${n}`, jobId: 9000 + n, kind: "openai-image", label: `job-${n}.png`, originWindow: "main", revision: n,
  createdAtMs: START, updatedAtMs: START + 38_000, state, ...extra,
});

const jobsPanelText = (): string => render(JobsPanel as never, { props: { open: true, onClose() {} } } as never).body;
const progressText = (): string => render(ProgressDialog as never, {} as never).body;
const times = (html: string) => [...html.matchAll(/class="job-time[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
const elapsed = (html: string) => [...html.matchAll(/>(\d+m \d+s|\d+s) elapsed</g)].map((m) => m[1]);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); jobsStore.applyNative([]); for (const job of [...jobsStore.jobs]) jobsStore.removeJob(job.id); });

describe("elapsed time of native jobs", () => {
  it.each([
    ["completed", record(1, "completed", { settledAtMs: START + 38_000 })],
    ["failed", record(1, "error", { settledAtMs: START + 38_000, error: "refused" })],
    ["cancelled", record(1, "cancelled", { settledAtMs: START + 38_000 })],
    ["discarded", record(1, "discarded", { settledAtMs: START + 38_000, phase: "stopped" })],
    ["stopped", record(1, "needs_attention", { settledAtMs: START + 38_000, phase: "stopped" })],
    // Last touched (dismissed) minutes after it settled: the end is still 38 s.
    ["settled earlier than its last update", record(1, "discarded", { settledAtMs: START + 38_000, updatedAtMs: START + 600_000, phase: "stopped" })],
  ])("a %s job keeps its 38s duration as time passes", (_label, settled) => {
    jobsStore.applyNative([settled]);
    vi.setSystemTime(START + 39_000);
    const early = [times(jobsPanelText()), elapsed(progressText())];
    vi.setSystemTime(START + 39_000 + 10 * 60_000);
    const later = [times(jobsPanelText()), elapsed(progressText())];
    expect(early).toEqual([["38s"], ["38s"]]);
    expect(later).toEqual(early);
  });

  it("a settled job with no recorded end shows no duration at all", () => {
    jobsStore.applyNative([record(1, "completed")]);
    vi.setSystemTime(START + 10 * 60_000);
    expect(times(jobsPanelText())).toEqual([""]);
    expect(elapsed(progressText())).toEqual([]);
  });

  it("an active job follows the clock", () => {
    jobsStore.applyNative([record(1, "running", { updatedAtMs: START })]);
    vi.setSystemTime(START + 5_000);
    expect(times(jobsPanelText())).toEqual(["5s"]);
    vi.setSystemTime(START + 65_000);
    expect(times(jobsPanelText())).toEqual(["1m 5s"]);
    expect(elapsed(progressText())).toEqual(["1m 5s"]);
  });
});
