#!/usr/bin/env node
// impact-map-source.mjs — which `e2e-impact-map` artifact a PR selects with
// (#1386).
//
// Maps come from two producers on dev: every ci.yml dev push (function-level
// coverage on the shared bundle) and the nightly e2e-impact-map.yml backstop
// (block coverage on the dev server). The newest trustworthy ci.yml map wins,
// else the newest trustworthy nightly one; drift since its commit is handled
// by the selector (scripts/e2e-affected.mjs). ci.yml maps come first because
// they are recorded on the shared bundle that PR shards serve: a shard serving
// another kind of app server than the map's runs every spec (#1391), so a
// newer dev-server map would make every bundle shard run in full.
//
// Trust: an artifact's name proves nothing, since any workflow run can upload
// one called `e2e-impact-map`, including a pull_request run whose head branch
// is named `dev` in a fork. A producer counts only if its run is a push,
// schedule or workflow_dispatch event of one of the two workflows, on `dev`,
// in this repository.
//
// Usage: node scripts/impact-map-source.mjs <owner/repo>
//   prints "<artifact id> <run id> <head sha>" of the chosen artifact, or
//   nothing when there is none.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const MAP_ARTIFACT = "e2e-impact-map";
export const PRODUCER_WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/e2e-impact-map.yml"];
/** The producer whose maps share PR shards' app server (the bundle). */
const PREFERRED_PRODUCER = ".github/workflows/ci.yml";
const PRODUCER_EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);

/**
 * @typedef {{ id: number, name: string, expired: boolean, created_at: string,
 *   workflow_run?: { id: number, head_branch?: string, head_sha?: string } }} Artifact
 * @typedef {{ id: number, event: string, head_branch: string, path: string,
 *   repository: { full_name: string }, head_repository?: { full_name: string } | null }} Run
 */

/**
 * Whether a workflow run may publish the map PRs trust.
 * @param {Run} run
 * @param {string} repo
 */
export function trustedProducer(run, repo) {
  const path = (run.path ?? "").split("@")[0];
  return PRODUCER_EVENTS.has(run.event) &&
    run.head_branch === "dev" &&
    PRODUCER_WORKFLOWS.includes(path) &&
    run.repository?.full_name === repo &&
    (run.head_repository?.full_name ?? repo) === repo;
}

/**
 * The newest unexpired map artifact from a trusted ci.yml run, else from any
 * trusted producer.
 * @param {Artifact[]} artifacts
 * @param {(runId: number) => Run | null} runOf
 * @param {string} repo
 * @returns {{ artifact: number, run: number, sha: string } | null}
 */
export function pickMapArtifact(artifacts, runOf, repo) {
  const candidates = artifacts
    .filter((a) => a.name === MAP_ARTIFACT && !a.expired && a.workflow_run?.id && a.workflow_run.head_branch === "dev")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  /** @type {{ artifact: number, run: number, sha: string } | null} */
  let fallback = null;
  for (const artifact of candidates) {
    const run = runOf(/** @type {number} */ (artifact.workflow_run?.id));
    if (run && trustedProducer(run, repo) && artifact.workflow_run?.head_sha) {
      const pick = { artifact: artifact.id, run: run.id, sha: artifact.workflow_run.head_sha };
      if ((run.path ?? "").split("@")[0] === PREFERRED_PRODUCER) return pick;
      fallback ??= pick;
    }
  }
  return fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = process.argv[2];
  if (!repo) { console.error("usage: impact-map-source.mjs <owner/repo>"); process.exit(2); }
  const api = (/** @type {string} */ path) =>
    JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 1 << 26 }));
  const { artifacts } = api(`repos/${repo}/actions/artifacts?name=${MAP_ARTIFACT}&per_page=30`);
  const picked = pickMapArtifact(artifacts, (id) => {
    try { return api(`repos/${repo}/actions/runs/${id}`); } catch { return null; }
  }, repo);
  if (picked) console.log(`${picked.artifact} ${picked.run} ${picked.sha}`);
}
