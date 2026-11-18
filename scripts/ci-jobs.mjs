#!/usr/bin/env node
// ci-jobs.mjs — explain and recover failed CI jobs (#1367).
//
// Usage:
//   node scripts/ci-jobs.mjs report <job> [<job> ...]
//     Run by ci.yml's gate jobs (frontend, webkit, rust). Prints each named
//     upstream job's result — every matrix shard of it — and, for a failed or
//     cancelled one, the step it stopped at, read from the current run attempt
//     through the Actions API. Diagnostics only: the gate's own checks decide.
//   node scripts/ci-jobs.mjs auto-rerun
//     Run by ci-auto-rerun.yml on `workflow_run: completed`. Re-runs the failed
//     jobs of a failed first attempt once, and only when every failed job
//     stopped at an install or setup step (the slow-mirror class of failure).
//     A failure in a test step, a superseded (cancelled) run, a failed run
//     that a newer PR or dev push run has superseded, or any later attempt is
//     left alone, so the workflow cannot loop or cancel the newer run.
//
// Environment: GITHUB_REPOSITORY, GH_TOKEN (or GITHUB_TOKEN), GITHUB_API_URL;
// report also reads GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT, auto-rerun reads
// RUN_ID and RUN_ATTEMPT (the completed run's).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @typedef {{ name: string, status?: string, conclusion: string | null, number?: number }} Step */
/** @typedef {{ id?: number, name: string, status?: string, conclusion: string | null, steps?: Step[] }} Job */

/** Conclusions that mean a job or step did not succeed. */
const UNSUCCESSFUL = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

/**
 * Steps that only provision the job: runner and container setup, checkout,
 * toolchains, dependency and browser installs, cache transport.
 */
export const SETUP_STEP =
  /^(set up job|initialize containers|run actions\/(checkout|cache|download-artifact)\b|run oven-sh\/setup-bun\b|run dtolnay\/rust-toolchain\b|run swatinem\/rust-cache\b)|\binstall\b|refresh apt|^restore .*cache|cache key$|^probe test-result cache$/i;

/**
 * Gate jobs that fail only because an upstream job did. They are re-run with
 * their upstream jobs and never decide whether to re-run. Each also carries
 * its targets' test-result cache report, and `frontend` the dev-push impact
 * map (#1802), all as continue-on-error steps.
 */
export const AGGREGATE_JOBS = new Set(["frontend", "webkit", "rust"]);

/**
 * The step a job stopped at: its first unsuccessful step, else the first one
 * still running (a job killed at its time limit), else null.
 * @param {Job} job
 * @returns {string | null}
 */
export function failingStep(job) {
  const steps = job.steps ?? [];
  const failed = steps.find((s) => s.conclusion !== null && UNSUCCESSFUL.has(s.conclusion));
  if (failed) return failed.name;
  return steps.find((s) => s.status === "in_progress")?.name ?? null;
}

/**
 * The jobs of a run that belong to `name`: the job itself or its matrix
 * entries (`name (…)`).
 * @param {Job[]} jobs
 * @param {string} name
 */
export const jobsNamed = (jobs, name) => jobs.filter((j) => j.name === name || j.name.startsWith(`${name} (`));

/**
 * One line per upstream job, plus GitHub error annotations for the failures.
 * @param {Job[]} jobs the current attempt's jobs
 * @param {string[]} needed upstream job ids as named in the workflow
 * @returns {{ lines: string[], annotations: string[] }}
 */
export function describeJobs(jobs, needed) {
  const lines = [];
  const annotations = [];
  for (const name of needed) {
    const matching = jobsNamed(jobs, name);
    if (matching.length === 0) {
      lines.push(`${name}: not started (skipped by its condition, or never scheduled)`);
      continue;
    }
    for (const job of [...matching].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
      const result = job.conclusion ?? job.status ?? "unknown";
      if (job.conclusion !== null && UNSUCCESSFUL.has(job.conclusion)) {
        const step = failingStep(job);
        const where = step ? ` at step "${step}"` : " before any step ran";
        const kind = step && SETUP_STEP.test(step) ? " (install/setup step: infrastructure, eligible for one automatic re-run)" : "";
        lines.push(`${job.name}: ${result}${where}${kind}`);
        annotations.push(`::error title=${job.name} ${result}::${job.name} ${result}${where}${kind}`);
      } else {
        lines.push(`${job.name}: ${result}`);
      }
    }
  }
  return { lines, annotations };
}

/**
 * Whether a completed run's failed jobs should be re-run automatically.
 * @param {{ conclusion: string | null, runAttempt: number, jobs: Job[], maxAttempt?: number }} run
 * @returns {{ rerun: boolean, reason: string }}
 */
export function rerunDecision({ conclusion, runAttempt, jobs, maxAttempt = 1 }) {
  if (conclusion !== "failure") return { rerun: false, reason: `run concluded ${conclusion ?? "without a conclusion"}` };
  if (!Number.isInteger(runAttempt) || runAttempt < 1) return { rerun: false, reason: `unknown run attempt ${runAttempt}` };
  if (runAttempt > maxAttempt) return { rerun: false, reason: `attempt ${runAttempt} already follows an automatic re-run` };
  const failed = jobs.filter((j) => !AGGREGATE_JOBS.has(j.name) && j.conclusion !== null && UNSUCCESSFUL.has(j.conclusion));
  if (failed.length === 0) return { rerun: false, reason: "no non-gate job failed" };
  const real = failed.filter((j) => {
    const step = failingStep(j);
    return step !== null && !SETUP_STEP.test(step);
  });
  if (real.length > 0) {
    return { rerun: false, reason: `${real.map((j) => `${j.name} failed at "${failingStep(j)}"`).join("; ")}: not an install/setup failure` };
  }
  return {
    rerun: true,
    reason: `${failed.map((j) => `${j.name} at "${failingStep(j) ?? "job setup"}"`).join("; ")}: install/setup failure`,
  };
}

/**
 * @typedef {{ id: number, event: string, head_sha: string, head_branch?: string | null,
 *   workflow_id?: number, pull_requests?: { number: number }[] }} RunInfo
 */

/** The branch whose push runs share one cancel-in-progress group per workflow (#1798). */
export const SUPERSEDED_PUSH_BRANCH = "dev";

/** @param {RunInfo} run */
const isDevPush = (run) => run.event === "push" && run.head_branch === SUPERSEDED_PUSH_BRANCH;

/**
 * Why re-running a failed run would be wrong, or null when it is still the
 * current run of its concurrency group. pull_request runs share a
 * cancel-in-progress group per PR, and dev push runs one per workflow
 * (#1798): a re-run joins that group, so re-running a superseded run would
 * cancel the newer run for the latest commit. Other runs (main pushes, the
 * schedule, dispatch) use unique groups and are never stale here.
 * @param {RunInfo} run the failed run
 * @param {{ newerRuns: { id: number }[], prHeads: string[], branchHead?: string | null }} context
 *   newerRuns: the same workflow's runs of the same event for run.head_branch;
 *   prHeads: the current head SHA of each PR the run belongs to;
 *   branchHead: the dev branch's current head SHA (dev push runs)
 * @returns {string | null}
 */
export function staleRunReason(run, { newerRuns, prHeads, branchHead }) {
  const devPush = isDevPush(run);
  if (run.event !== "pull_request" && !devPush) return null;
  const newer = newerRuns.filter((r) => r.id > run.id);
  if (newer.length > 0) return `run ${newer[0].id} is a newer run of this workflow for ${run.head_branch ?? "the PR branch"}`;
  if (devPush) {
    if (!branchHead) return `${SUPERSEDED_PUSH_BRANCH}'s head could not be read, so the run cannot be confirmed current`;
    if (branchHead !== run.head_sha) return `${SUPERSEDED_PUSH_BRANCH} moved from ${run.head_sha} to ${branchHead}`;
    return null;
  }
  if (prHeads.length === 0) return "no open pull request is associated with the run, so it cannot be confirmed current";
  const moved = prHeads.find((sha) => sha !== run.head_sha);
  if (moved) return `the pull request's head moved from ${run.head_sha} to ${moved}`;
  return null;
}

/**
 * @param {string} path
 * @param {{ method?: string, fetchApi?: typeof fetch, env?: NodeJS.ProcessEnv }} [options]
 */
async function github(path, { method = "GET", fetchApi = fetch, env = process.env } = {}) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token || !env.GITHUB_REPOSITORY) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetchApi(`${api}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed (${response.status})`);
  return response.status === 204 || response.status === 201 ? null : response.json();
}

/**
 * Every job of one run attempt.
 * @param {string} runId
 * @param {string} attempt
 * @returns {Promise<Job[]>}
 */
async function attemptJobs(runId, attempt) {
  /** @type {Job[]} */
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const data = await github(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    jobs.push(...data.jobs);
    if (data.jobs.length < 100) break;
  }
  return jobs;
}

/** @param {string} id */
const numeric = (id) => {
  if (!/^\d+$/.test(id ?? "")) throw new Error(`expected a numeric id, got ${JSON.stringify(id)}`);
  return id;
};

async function report(/** @type {string[]} */ needed) {
  const jobs = await attemptJobs(numeric(process.env.GITHUB_RUN_ID ?? ""), numeric(process.env.GITHUB_RUN_ATTEMPT ?? ""));
  const { lines, annotations } = describeJobs(jobs, needed);
  for (const line of lines) console.log(line);
  for (const annotation of annotations) console.log(annotation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Upstream job results\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  }
}

/**
 * Evidence for staleRunReason: newer runs of the same workflow and event on
 * the run's head branch, plus the live head of each associated PR (a
 * pull_request run) or of dev (a dev push run).
 * @param {RunInfo} run
 */
async function currentness(run) {
  const devPush = isDevPush(run);
  if (run.event !== "pull_request" && !devPush) return { newerRuns: [], prHeads: [] };
  const branch = encodeURIComponent(run.head_branch ?? "");
  const { workflow_runs: newerRuns } =
    await github(`/actions/workflows/${run.workflow_id}/runs?event=${run.event}&branch=${branch}&per_page=20`);
  if (devPush) {
    const head = await github(`/branches/${SUPERSEDED_PUSH_BRANCH}`);
    return { newerRuns, prHeads: [], branchHead: head?.commit?.sha ?? null };
  }
  /** @type {string[]} */
  const prHeads = [];
  for (const pr of run.pull_requests ?? []) {
    const live = await github(`/pulls/${pr.number}`);
    if (live.state === "open") prHeads.push(live.head.sha);
  }
  return { newerRuns, prHeads };
}

async function autoRerun() {
  const runId = numeric(process.env.RUN_ID ?? "");
  const attempt = numeric(process.env.RUN_ATTEMPT ?? "");
  const run = await github(`/actions/runs/${runId}/attempts/${attempt}`);
  const decision = rerunDecision({
    conclusion: run.conclusion,
    runAttempt: Number(run.run_attempt),
    jobs: await attemptJobs(runId, attempt),
  });
  if (decision.rerun) {
    const stale = staleRunReason(run, await currentness(run));
    if (stale) Object.assign(decision, { rerun: false, reason: `${decision.reason}, but ${stale}` });
  }
  console.log(`${run.name ?? "run"} ${runId} attempt ${attempt}: ${decision.rerun ? "re-running failed jobs" : "no re-run"} (${decision.reason})`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Run ${runId} attempt ${attempt}: ${decision.rerun ? "re-ran failed jobs" : "not re-run"} — ${decision.reason}\n`);
  }
  if (decision.rerun) await github(`/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...args] = process.argv.slice(2);
  const action = command === "report" && args.length > 0 ? report(args)
    : command === "auto-rerun" ? autoRerun()
    : Promise.reject(new Error("usage: ci-jobs.mjs report <job...> | auto-rerun"));
  action.catch((error) => {
    console.error(`[ci-jobs] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
