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
  it("labels native progress as an estimate and shows overdue work without completion", () => {
    jobsStore.applyNative([record(1, "running", { estimateKey: "fast" })]);
    vi.setSystemTime(START + 30_000);
    expect(progressText()).toContain("Estimate · ~1m 30s remaining");
    vi.setSystemTime(START + 180_000);
    const overdue = progressText();
    expect(overdue).toContain("Estimate · longer than usual");
    expect(overdue).not.toContain("100%");
    expect(overdue).not.toContain("0s remaining");
    expect(overdue).not.toContain(">Complete<");
  });

  it("passes native cohort identity and settled timings to the progress estimate", () => {
    const past = [1,2,3].map(n=>record(n, "completed", { createdAtMs:START-120_000, settledAtMs:START-80_000, estimateKey:"fast" }));
    const slow = [4,5,6].map(n=>record(n, "completed", { createdAtMs:START-240_000, settledAtMs:START-40_000, estimateKey:"slow" }));
    jobsStore.applyNative([...past,...slow,record(7,"running",{estimateKey:"fast"})]);
    vi.setSystemTime(START+20_000);
    expect(progressText()).toContain("Estimate · ~20s remaining");
  });
  it("acknowledges cancellation while a native job is still running", async () => {
    jobsStore.applyNative([record(1,"running")]);
    jobsStore.configureNativeControls({cancel:async()=>{},dismiss:async()=>{},resume:async()=>{}});
    await jobsStore.controlJob(9001,"cancel");
    expect(progressText()).toContain("cancellation requested");
    expect(progressText()).toContain("Estimate ·");
    jobsStore.configureNativeControls(null);
  });
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
