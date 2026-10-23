import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AGGREGATE_JOBS, describeJobs, failingStep, rerunDecision } from "../scripts/ci-jobs.mjs";

type Step = { name: string; status?: string; conclusion: string | null };
const step = (name: string, conclusion: string | null = "success", status = "completed"): Step => ({ name, status, conclusion });
const job = (name: string, conclusion: string | null, steps: Step[] = []) => ({ name, status: "completed", conclusion, steps });

const installHang = job("webkit-tests (3)", "cancelled", [
  step("Set up job"), step("Run actions/checkout@v7"), step("Install dependencies", "cancelled"), step("E2E tests (WebKit)", "skipped"),
]);
const testFailure = job("chromium (2)", "failure", [step("Set up job"), step("E2E tests", "failure")]);
const gate = job("webkit", "failure", [step("Require all WebKit browser outcomes", "failure")]);

describe("failingStep", () => {
  it("names the first unsuccessful step", () => {
    expect(failingStep(installHang)).toBe("Install dependencies");
    expect(failingStep(testFailure)).toBe("E2E tests");
  });

  it("names a step still running when the job was killed", () => {
    expect(failingStep(job("x", "cancelled", [step("Set up job"), step("E2E tests", null, "in_progress")]))).toBe("E2E tests");
  });

  it("returns null for a job that ran no step", () => {
    expect(failingStep(job("x", "failure"))).toBeNull();
  });
});

describe("describeJobs", () => {
  it("prints every shard's result and where each failure stopped", () => {
    const jobs = [job("webkit-tests (1)", "success"), installHang, testFailure, job("chromium (1)", "success")];
    const { lines, annotations } = describeJobs(jobs, ["chromium", "webkit-tests", "chromium-view-modes"]);
    expect(lines).toEqual([
      "chromium (1): success",
      'chromium (2): failure at step "E2E tests"',
      "webkit-tests (1): success",
      'webkit-tests (3): cancelled at step "Install dependencies" (install/setup step: infrastructure, eligible for one automatic re-run)',
      "chromium-view-modes: not started (skipped by its condition, or never scheduled)",
    ]);
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toMatch(/^::error title=chromium \(2\) failure::/);
  });

  it("does not confuse a job with another whose name it prefixes", () => {
    const { lines } = describeJobs([job("chromium-view-modes (1)", "success")], ["chromium"]);
    expect(lines).toEqual(["chromium: not started (skipped by its condition, or never scheduled)"]);
  });
});

describe("rerunDecision", () => {
  it("re-runs a first attempt whose only failures are install/setup steps", () => {
    const setup = job("rust-suite (default)", "failure", [step("Set up job"), step("Install Tauri Linux system dependencies", "failure")]);
    const result = rerunDecision({ conclusion: "failure", runAttempt: 1, jobs: [installHang, setup, gate, job("frontend", "success")] });
    expect(result.rerun).toBe(true);
    expect(result.reason).toContain('webkit-tests (3) at "Install dependencies"');
  });

  it.each([
    ["Initialize containers"], ["Run oven-sh/setup-bun@v2"], ["Restore test-result cache"], ["Install Linux WebKit driver"],
    ["Refresh apt package index"], ["Test-result cache key"],
  ])("treats %s as setup", (name) => {
    expect(rerunDecision({ conclusion: "failure", runAttempt: 1, jobs: [job("x", "failure", [step(name, "failure")])] }).rerun).toBe(true);
  });

  it("re-runs a job that failed before any step", () => {
    expect(rerunDecision({ conclusion: "failure", runAttempt: 1, jobs: [job("x", "failure")] }).rerun).toBe(true);
  });

  it("leaves a real test failure alone, even beside an install failure", () => {
    const result = rerunDecision({ conclusion: "failure", runAttempt: 1, jobs: [installHang, testFailure, gate] });
    expect(result).toEqual({ rerun: false, reason: 'chromium (2) failed at "E2E tests": not an install/setup failure' });
  });

  it("re-runs at most once: a later attempt never re-runs", () => {
    expect(rerunDecision({ conclusion: "failure", runAttempt: 2, jobs: [installHang] })).toEqual({
      rerun: false, reason: "attempt 2 already follows an automatic re-run",
    });
  });

  it.each(["success", "cancelled", null])("does nothing for a run that concluded %s", (conclusion) => {
    expect(rerunDecision({ conclusion, runAttempt: 1, jobs: [installHang] }).rerun).toBe(false);
  });

  it("ignores gates that failed only because an upstream job did", () => {
    expect(rerunDecision({ conclusion: "failure", runAttempt: 1, jobs: [gate] })).toEqual({ rerun: false, reason: "no non-gate job failed" });
    expect(rerunDecision({ conclusion: "failure", runAttempt: Number.NaN, jobs: [installHang] }).rerun).toBe(false);
  });

  it("knows ci.yml's aggregate jobs", () => {
    const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const aggregates = Object.entries(ci.jobs as Record<string, { if?: string }>)
      .filter(([, j]) => j.if === "always()").map(([id]) => id).sort();
    expect(aggregates).toEqual([...AGGREGATE_JOBS].sort());
  });
});

describe("workflow wiring", () => {
  const workflows = new URL("../.github/workflows/", import.meta.url);
  const load = (file: string) => parse(readFileSync(new URL(file, workflows), "utf8"));

  it("re-runs only failed first attempts of CI and native smoke, with minimal permissions", () => {
    const rerun = load("ci-auto-rerun.yml");
    expect(rerun.on).toEqual({ workflow_run: { workflows: ["CI", "Tauri binary E2E (smoke)"], types: ["completed"] } });
    expect(rerun.permissions).toEqual({ actions: "write", contents: "read" });
    expect(rerun.jobs.rerun.if).toBe("github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.run_attempt == 1");
    expect(load("ci.yml").name).toBe("CI");
    expect(load("e2e-tauri.yml").name).toBe("Tauri binary E2E (smoke)");
    // Never checks out or runs the triggering run's code.
    for (const s of rerun.jobs.rerun.steps) expect(JSON.stringify(s)).not.toContain("head_sha");
  });

  it.each([
    ["frontend", "frontend-checks chromium chromium-view-modes"],
    ["webkit", "webkit-tests"],
    ["rust", "rust-suite"],
  ])("reports %s's upstream results without letting the report decide", (gateId, needed) => {
    const steps = load("ci.yml").jobs[gateId].steps as { run?: string; "continue-on-error"?: boolean }[];
    const report = steps.find((s) => s.run?.startsWith("node scripts/ci-jobs.mjs report"));
    expect(report?.run).toBe(`node scripts/ci-jobs.mjs report ${needed}`);
    expect(report?.["continue-on-error"]).toBe(true);
    expect(steps.at(-1)?.run).toMatch(/\btest\b|\$ok/);
  });
});
