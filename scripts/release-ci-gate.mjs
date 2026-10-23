#!/usr/bin/env node
// release-ci-gate.mjs — refuse a release whose tree did not pass dev CI (#1367).
//
// Usage:  node scripts/release-ci-gate.mjs [--wait-minutes N]
//   Run by release.yml before it reads the version, tags or builds. PRs into
//   main no longer run CI, so the evidence is the dev push of the same code:
//   a dev commit whose tree is byte-identical to the released commit's tree
//   (normally the merge base, the second parent of the dev->main merge).
//   It passes only when such a commit has
//     - a ci.yml push run on dev whose latest attempt concluded success, and
//     - an e2e-tauri.yml push run on dev whose `smoke (ubuntu-latest)` job
//       succeeded (the required native context; Windows remains advisory).
//   While a matching run is still queued or in progress it waits, polling
//   every minute, for up to --wait-minutes (default 60). Anything else fails.
//
// Environment: GITHUB_SHA (released commit), GITHUB_REPOSITORY, GH_TOKEN,
// GITHUB_API_URL. Needs the dev history fetched as origin/dev.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const NATIVE_WORKFLOW = ".github/workflows/e2e-tauri.yml";
export const NATIVE_REQUIRED_JOB = "smoke (ubuntu-latest)";

/** @typedef {{ id: number, path: string, event: string, head_branch: string, head_sha: string, status: string, conclusion: string | null, run_attempt?: number, html_url?: string }} Run */
/** @typedef {{ name: string, status: string, conclusion: string | null }} Job */
/** @typedef {{ verdict: "pass" | "pending" | "fail", reason: string }} GateResult */

/**
 * Dev commits carrying exactly the released tree, most recent first.
 * @param {string} releaseTree
 * @param {{ sha: string, tree: string }[]} devCommits newest first
 */
export const candidateCommits = (releaseTree, devCommits) =>
  devCommits.filter((c) => c.tree === releaseTree).map((c) => c.sha);

/**
 * Judge one candidate commit from its dev push runs.
 * @param {Run[]} runs workflow runs for the commit (any event or branch)
 * @param {(run: Run) => Job[]} jobsOf jobs of a run's latest attempt
 * @param {string} repository owner/name the runs must come from
 * @returns {GateResult}
 */
export function judgeCommit(runs, jobsOf, repository) {
  const devPush = (/** @type {Run} */ r) => r.event === "push" && r.head_branch === "dev" &&
    (/** @type {any} */ (r).head_repository?.full_name ?? repository) === repository;
  const ci = runs.filter((r) => devPush(r) && r.path === CI_WORKFLOW);
  const native = runs.filter((r) => devPush(r) && r.path === NATIVE_WORKFLOW);
  if (ci.length === 0) return { verdict: "fail", reason: "no dev push CI run" };
  if (native.length === 0) return { verdict: "fail", reason: "no dev push native smoke run" };

  const ciPassed = ci.some((r) => r.status === "completed" && r.conclusion === "success");
  const ciPending = ci.some((r) => r.status !== "completed");
  const nativePassed = native.some((r) => r.status === "completed" &&
    jobsOf(r).some((j) => j.name === NATIVE_REQUIRED_JOB && j.status === "completed" && j.conclusion === "success"));
  const nativePending = native.some((r) => r.status !== "completed");

  if (ciPassed && nativePassed) return { verdict: "pass", reason: "dev push CI and native smoke passed" };
  if ((!ciPassed && ciPending) || (!nativePassed && nativePending)) {
    return { verdict: "pending", reason: "dev push CI or native smoke is still running" };
  }
  const missing = [!ciPassed && "CI did not succeed", !nativePassed && `${NATIVE_REQUIRED_JOB} did not succeed`].filter(Boolean);
  return { verdict: "fail", reason: missing.join("; ") };
}

/**
 * Combine per-candidate results: any pass wins, then any pending.
 * @param {{ sha: string, result: GateResult }[]} results
 * @returns {GateResult}
 */
export function combine(results) {
  if (results.length === 0) {
    return { verdict: "fail", reason: "no dev commit has the released tree; release only code that passed dev CI" };
  }
  const pass = results.find((r) => r.result.verdict === "pass");
  if (pass) return { verdict: "pass", reason: `${pass.sha}: ${pass.result.reason}` };
  const pending = results.find((r) => r.result.verdict === "pending");
  if (pending) return { verdict: "pending", reason: `${pending.sha}: ${pending.result.reason}` };
  return { verdict: "fail", reason: results.map((r) => `${r.sha}: ${r.result.reason}`).join("; ") };
}

/** @param {string[]} args */
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** @param {string} path */
async function github(path) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || !process.env.GITHUB_REPOSITORY) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${api}/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path} failed (${response.status})`);
  return response.json();
}

async function evaluate(/** @type {string} */ releaseSha) {
  const releaseTree = git("rev-parse", `${releaseSha}^{tree}`);
  const commits = git("log", "--format=%H %T", "-n", "200", "origin/dev").split("\n").filter(Boolean)
    .map((line) => { const [sha, tree] = line.split(" "); return { sha, tree }; });
  const candidates = candidateCommits(releaseTree, commits).slice(0, 5);
  const repository = /** @type {string} */ (process.env.GITHUB_REPOSITORY);
  const results = [];
  for (const sha of candidates) {
    const { workflow_runs: runs } = await github(`/actions/runs?head_sha=${sha}&event=push&branch=dev&per_page=100`);
    /** @type {Map<number, Job[]>} */
    const jobs = new Map();
    for (const run of runs) {
      if (run.path === NATIVE_WORKFLOW && run.status === "completed") {
        jobs.set(run.id, (await github(`/actions/runs/${run.id}/jobs?per_page=100`)).jobs);
      }
    }
    results.push({ sha, result: judgeCommit(runs, (r) => jobs.get(r.id) ?? [], repository) });
  }
  return { releaseTree, result: combine(results) };
}

async function main() {
  const at = process.argv.indexOf("--wait-minutes");
  const waitMinutes = at >= 0 ? Number(process.argv[at + 1]) : 60;
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) throw new Error("--wait-minutes needs a non-negative number");
  const releaseSha = process.env.GITHUB_SHA || git("rev-parse", "HEAD");
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const { releaseTree, result } = await evaluate(releaseSha);
    console.log(`Release ${releaseSha} (tree ${releaseTree}): ${result.verdict} — ${result.reason}`);
    if (result.verdict === "pass") {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Dev CI gate passed: ${result.reason}\n`);
      return;
    }
    if (result.verdict === "fail" || Date.now() >= deadline) {
      console.log(`::error title=Release refused::No successful dev push CI for tree ${releaseTree}: ${result.reason}`);
      process.exit(1);
    }
    await sleep(60_000);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.log(`::error title=Release refused::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
