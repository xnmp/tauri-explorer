#!/usr/bin/env node
// test-cache.mjs — CI test-result cache over Turborepo task hashing (#1176).
//
// Usage:
//   node scripts/test-cache.mjs key   --target <name>                 artifact key, prefix and dir
//   node scripts/test-cache.mjs restore --target <name>               restore a protected-dev artifact
//   node scripts/test-cache.mjs pack --target <name>                  preserve entries for upload
//   node scripts/test-cache.mjs probe --task <ci:task> --target <name> hit=true|false before setup
//   node scripts/test-cache.mjs run   --task <ci:task> --target <name> run or replay the target
//   node scripts/test-cache.mjs explain --task <ci:task>               hash, hashed files and env
//   node scripts/test-cache.mjs report <dir>                          hit-rate summary of a run
//
// Turborepo computes each target's hash from the inputs and env vars turbo.json
// names, and replays a passing result for an unchanged hash; it never stores a
// failed task. This script only decides access and reports:
//   - Only protected dev pushes publish result artifacts. PRs and local runs
//     cannot upload artifacts into those runs: GitHub enforces run ownership.
//   - Restore verifies a target pass record from a protected-dev CI attempt,
//     never from GitHub's shared cache namespace or from a PR workflow run.
//   - TEST_CACHE_READ=false re-runs every target (bypass).
//   - The local Turborepo directory lives outside the checkout (RUNNER_TEMP).
//   - TEST_CACHE_TOOLCHAIN (hashed via turbo.json's globalEnv) carries the
//     versions of the tools a target runs on.
//   - With TEST_CACHE_NORMALIZE_VERSION=1 (browser jobs) the root package.json
//     version is hashed as a placeholder, so a release bump replays e2e (#1367).
// See .github/workflows/CLAUDE.md for detecting a stale hit and bypassing.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const CACHE_VERSION = "v3";
/**
 * Entries older than this are dropped before probing or executing. The tar
 * envelope keeps file times and hits save nothing, so age counts from creation; a
 * dropped entry re-runs once and is stored afresh.
 */
export const PRUNE_AFTER_MS = 30 * 86_400_000;

/** The only runs whose results may be stored (ci.yml's TEST_CACHE_WRITE). */
export const TRUSTED_WRITE = "github.event_name == 'push' && github.ref == 'refs/heads/dev'";

/** Tool versions each target's result depends on. */
const TASK_TOOLCHAINS = {
  "ci:unit": ["bun", "node"],
  "ci:e2e": ["bun", "node"],
  "ci:rust": ["rust", "apt"],
};

/** @type {Record<string, [string, string[]][]>} */
const TOOL_PROBES = {
  bun: [["bun", ["--version"]]],
  node: [["node", ["--version"]]],
  rust: [["rustc", ["-Vv"]], ["cargo", ["-V"]]],
};

const TURBO = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "turbo");
const TARGET = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ read: boolean, write: boolean }}
 */
export function trust(env) {
  return { read: env.TEST_CACHE_READ !== "false", write: env.TEST_CACHE_WRITE === "true" };
}

/** Turborepo's --cache value; remote caching stays off. */
export function cacheMode(/** @type {{ read: boolean, write: boolean }} */ { read, write }) {
  return `local:${read ? "r" : ""}${write ? "w" : ""}`;
}

/**
 * Turborepo would read entries from a directory PR content can populate.
 * @param {string} dir
 * @param {string} workspace
 */
export function assertOutsideWorkspace(dir, workspace) {
  const rel = relative(resolve(workspace), resolve(dir));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`test-cache: cache directory ${dir} is inside the checkout ${workspace}`);
  }
}

/** @param {Record<string, string | undefined>} env */
function platformId(env) {
  const part = (/** @type {string | undefined} */ v, /** @type {string} */ fallback) =>
    v && /^[A-Za-z0-9._]+$/.test(v) ? v : fallback;
  return [
    part(env.RUNNER_OS, process.platform),
    part(env.RUNNER_ARCH, process.arch),
    part(env.ImageOS, "noimage"),
    part(env.ImageVersion, "noversion"),
  ].join("-");
}

/**
 * Artifact key for one target. Each producing run uploads a distinct name;
 * restore picks a matching platform prefix only within eligible dev runs.
 * @param {Record<string, string | undefined>} env
 * @param {string} target
 */
export function cacheKeys(env, target) {
  if (!TARGET.test(target)) throw new Error(`test-cache: invalid target name ${JSON.stringify(target)}`);
  const prefix = `test-cache-${CACHE_VERSION}-${platformId(env)}-${target}-`;
  return { prefix, key: `${prefix}${env.GITHUB_RUN_ID ?? "local"}-${env.GITHUB_RUN_ATTEMPT ?? "0"}` };
}

/**
 * @param {string[]} kinds bun, node, rust, apt
 * @param {(cmd: string, args: string[]) => string} exec
 * @param {string} [aptPackages] space-separated packages the job installs
 */
export function toolchainFingerprint(kinds, exec, aptPackages = "") {
  const flat = (/** @type {string} */ s) => s.trim().split(/\s+/).join(" ");
  const parts = [];
  for (const kind of kinds) {
    if (kind === "apt") {
      const packages = aptPackages.trim().split(/\s+/).filter(Boolean);
      if (packages.length === 0) continue;
      let policy = "";
      try { policy = exec("apt-cache", ["policy", ...packages]); } catch { /* listed as unavailable */ }
      const versions = packages.map((p) => {
        const block = policy.split(/^(?=\S)/m).find((b) => b.startsWith(`${p}:`));
        return `${p}=${block?.match(/Candidate:\s*(\S+)/)?.[1] ?? "unavailable"}`;
      });
      parts.push(`apt ${versions.join(" ")}`);
      continue;
    }
    for (const [cmd, args] of TOOL_PROBES[kind] ?? []) {
      try {
        const out = flat(exec(cmd, args));
        parts.push(out.startsWith(cmd) ? out : `${cmd} ${out}`);
      } catch {
        parts.push(`${cmd} ${args.join(" ")}: unavailable`);
      }
    }
  }
  return parts.join(" | ");
}

/**
 * @typedef {{ target: string, task: string, hash: string, cached: boolean, passed: boolean,
 *   stored: boolean, exitCode: number, durationMs: number, timeSavedMs: number }} CacheRecord
 */

/**
 * Reduce a Turborepo run summary (--summarize) to the target's cache outcome.
 * @param {any} summary
 * @param {string} target
 * @param {{ write: boolean }} access
 * @returns {CacheRecord}
 */
export function taskRecord(summary, target, { write }) {
  const task = summary.tasks[0];
  const cached = task.cache?.status === "HIT";
  const exitCode = task.execution?.exitCode ?? 1;
  const passed = exitCode === 0;
  return {
    target,
    task: task.taskId,
    hash: task.hash,
    cached,
    passed,
    stored: !cached && passed && write,
    exitCode,
    durationMs: Math.max(0, (task.execution?.endTime ?? 0) - (task.execution?.startTime ?? 0)),
    timeSavedMs: cached ? task.cache.timeSaved ?? 0 : 0,
  };
}

/** @param {number} ms */
const duration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** @param {CacheRecord} r */
export function describeRecord(r) {
  if (r.cached) return `${r.target}: passed from the test-result cache (hash ${r.hash}; saved ${duration(r.timeSavedMs)})`;
  if (!r.passed) {
    return `${r.target}: FAILED after ${duration(r.durationMs)} (hash ${r.hash}); failures are never cached, so the next run re-runs it`;
  }
  const storage = r.stored ? "stored for later runs" : "not stored, this run may not write the cache";
  return `${r.target}: ran and passed in ${duration(r.durationMs)} (hash ${r.hash}); ${storage}`;
}

/** @param {CacheRecord[]} records */
export function formatReport(records) {
  const lines = ["### Test-result cache (#1176)", ""];
  if (records.length === 0) {
    lines.push("No test target used the cache in this run (docs-only change, or no tests selected).");
    return `${lines.join("\n")}\n`;
  }
  const sorted = [...records].sort((a, b) => a.target.localeCompare(b.target));
  const hits = sorted.filter((r) => r.cached);
  const saved = hits.reduce((n, r) => n + r.timeSavedMs, 0);
  const executed = sorted.filter((r) => !r.cached).reduce((n, r) => n + r.durationMs, 0);
  lines.push(
    `**Hit rate: ${hits.length} of ${sorted.length} targets (${Math.round((100 * hits.length) / sorted.length)}%)**` +
      ` · saved ${duration(saved)} · executed ${duration(executed)}`,
    "",
    `Served from cache: ${hits.length ? hits.map((r) => r.target).join(", ") : "none"}`,
    "",
    "| Target | Result | Hash | Time |",
    "| --- | --- | --- | --- |",
  );
  for (const r of sorted) {
    const result = r.cached ? "passed from cache" : !r.passed ? "FAILED (not cached)" : r.stored ? "ran, passed, stored" : "ran, passed, not stored";
    const time = r.cached ? `saved ${duration(r.timeSavedMs)}` : duration(r.durationMs);
    lines.push(`| ${r.target} | ${result} | \`${r.hash}\` | ${time} |`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Cache files whose entry (all files sharing a hash) was created too long ago.
 * @param {{ name: string, mtimeMs: number }[]} files
 * @param {number} now
 * @param {number} maxAgeMs
 */
export function staleEntries(files, now, maxAgeMs) {
  const entry = (/** @type {string} */ name) => name.split(/[.-]/)[0];
  /** @type {Map<string, number>} */
  const newest = new Map();
  for (const f of files) newest.set(entry(f.name), Math.max(newest.get(entry(f.name)) ?? 0, f.mtimeMs));
  return files
    .filter((f) => now - /** @type {number} */ (newest.get(entry(f.name))) > maxAgeMs)
    .map((f) => f.name)
    .sort();
}

/** @param {string} target */
function targetTask(target) {
  if (target === "unit") return "ci:unit";
  if (/^rust-(default|opt-in)$/.test(target)) return "ci:rust";
  if (/^(chromium|webkit|chromium-view-modes)-[1-9]\d*$/.test(target)) return "ci:e2e";
  throw new Error(`test-cache: unknown target ${target}`);
}

/** @param {any} record @param {string} target */
function passingRecord(record, target) {
  return record?.target === target && record.task === targetTask(target) && record.passed === true &&
    record.exitCode === 0 && record.stored === true && record.cached === false && /^[a-f0-9]{16,64}$/.test(record.hash);
}

/**
 * Restore only verified target passes owned by protected-dev CI push attempts.
 * GitHub's artifact service binds IDs to runs; PR runtime credentials cannot
 * create an artifact in a dev run. Names/prefixes alone are not authorization.
 * Search a bounded 30-run window plus the current rerun; verify the producing
 * attempt independently of the run's mutable status. Missing results miss.
 * @param {Record<string, string | undefined>} env
 * @param {string} target
 * @param {typeof fetch} [fetchApi]
 * @param {string} [workspace]
 */
export async function restoreCache(env, target, fetchApi = fetch, workspace = process.cwd()) {
  if (!trust(env).read || !env.GH_TOKEN || !env.GITHUB_REPOSITORY) return false;
  const dir = cacheDir(env);
  assertOutsideWorkspace(dir, workspace);
  // Never mix restored content with entries planted earlier in this job.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { prefix } = cacheKeys(env, target);
  const task = targetTask(target);
  applyVersionBlindManifest(task, env, workspace);
  const expectedHash = dryRun(task, { read: false, write: false }, turboEnv(task, env), workspace)?.tasks?.[0]?.hash;
  if (!expectedHash) throw new Error(`test-cache: could not hash ${target} before restore`);
  const api = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" };
  const get = async (/** @type {string} */ path) => {
    const response = await fetchApi(`${api}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub artifact request failed (${response.status})`);
    return response;
  };
  // Do not filter by conclusion: rerunning changes the run's current status,
  // while earlier successful attempts and their artifacts remain valid.
  const data = await (await get("/actions/workflows/ci.yml/runs?branch=dev&event=push&per_page=30")).json();
  const runs = data.workflow_runs;
  if (/^\d+$/.test(env.GITHUB_RUN_ID ?? "") && Number(env.GITHUB_RUN_ATTEMPT) > 1) {
    // An old run being rerun can fall outside the recent-runs window.
    const index = runs.findIndex((/** @type {any} */ r) => String(r.id) === env.GITHUB_RUN_ID);
    const current = index >= 0 ? runs.splice(index, 1)[0] :
      await (await get(`/actions/runs/${env.GITHUB_RUN_ID}`)).json();
    runs.unshift(current);
  }
  const trusted = (/** @type {any} */ run) => run.event === "push" && run.head_branch === "dev" &&
    run.head_repository?.full_name === env.GITHUB_REPOSITORY && run.path === ".github/workflows/ci.yml";
  for (const run of runs) {
    if (!trusted(run)) continue;
    const list = await (await get(`/actions/runs/${run.id}/artifacts?per_page=100`)).json();
    const namePrefix = `trusted-${prefix}${run.id}-`;
    const candidates = list.artifacts.filter((/** @type {any} */ a) => !a.expired &&
      a.name.startsWith(namePrefix) && /^[1-9]\d*$/.test(a.name.slice(namePrefix.length)))
      .sort((/** @type {any} */ a, /** @type {any} */ b) =>
        Number(b.name.slice(namePrefix.length)) - Number(a.name.slice(namePrefix.length)));
    for (const artifact of candidates) {
      const number = Number(artifact.name.slice(namePrefix.length));
      if (!Number.isSafeInteger(number) || number > run.run_attempt) continue;
      const attempt = number === run.run_attempt ? run :
        await (await get(`/actions/runs/${run.id}/attempts/${number}`)).json();
      if (!trusted(attempt) || attempt.id !== run.id || attempt.run_attempt !== number ||
          attempt.head_sha !== run.head_sha || attempt.status !== "completed") continue;
      const zip = await (await get(`/actions/artifacts/${artifact.id}/zip`)).arrayBuffer();
      const staging = mkdtempSync(join(dirname(dir), "test-cache-restore-"));
      try {
        writeFileSync(join(staging, "artifact.zip"), Buffer.from(zip));
        // Python's zipfile, not unzip: the Playwright container has no unzip
        // (#1367). Its extractor drops absolute and `..` member paths.
        execFileSync("python3", ["-m", "zipfile", "-e", join(staging, "artifact.zip"), staging]);
        // Protected-dev pack publishes this record only for a newly passing
        // target. Unrelated job/attempt failures do not invalidate that result.
        const record = JSON.parse(readFileSync(join(staging, "result.json"), "utf8"));
        if (!passingRecord(record, target) || record.hash !== expectedHash) continue;
        execFileSync("tar", ["-xf", join(staging, "entries.tar"), "-C", dir]);
        prune(dir, Date.now());
        if (existsSync(join(dir, `${expectedHash}.tar.zst`))) return true;
      } catch (error) {
        console.warn(`Test-result artifact unavailable; trying another: ${error instanceof Error ? error.message : error}`);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  return false;
}

/** @param {Record<string, string>} opts */
function pack(opts) {
  const dir = cacheDir(process.env);
  assertOutsideWorkspace(dir, process.cwd());
  const archiveDir = join(process.env.RUNNER_TEMP || tmpdir(), "test-cache-archive", opts.target);
  cacheKeys(process.env, opts.target);
  mkdirSync(archiveDir, { recursive: true });
  const record = JSON.parse(readFileSync(join(reportDir(process.env), `${opts.target}.json`), "utf8"));
  if (!passingRecord(record, opts.target)) throw new Error("test-cache: only a newly passing target may be published");
  if (!existsSync(join(dir, `${record.hash}.tar.zst`))) throw new Error("test-cache: passing target has no cache entry");
  const entries = readdirSync(dir).filter((name) => name === `${record.hash}.tar.zst` || name === `${record.hash}-meta.json`);
  execFileSync("tar", ["-cf", join(archiveDir, "entries.tar"), "-C", dir, ...entries]);
  writeFileSync(join(archiveDir, "result.json"), `${JSON.stringify(record)}\n`);
  setOutputs({ archive: archiveDir });
}

// ---- CLI ----------------------------------------------------------------

/** @param {Record<string, string | undefined>} env */
const cacheDir = (env) => resolve(env.TEST_CACHE_DIR || join(env.RUNNER_TEMP || tmpdir(), "turbo-test-cache"));
/** @param {Record<string, string | undefined>} env */
const reportDir = (env) => resolve(env.TEST_CACHE_REPORT_DIR || join(env.RUNNER_TEMP || tmpdir(), "test-cache-report"));

/** @param {Record<string, string>} values */
function setOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

/** @param {string} markdown */
function addSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i] ?? "";
    else rest.push(argv[i]);
  }
  return { opts, rest };
}

/** Tasks whose results cannot depend on the root package.json `version`. */
export const VERSION_BLIND_TASKS = new Set(["ci:e2e"]);
export const MANIFEST_VERSION_PLACEHOLDER = "0.0.0-test-cache";

/**
 * The root package.json text with its top-level `version` value replaced by a
 * fixed placeholder and every other byte kept, so Turborepo (which always
 * hashes the root manifest) gives a release bump the same hash (#1367).
 * When that rewrite would touch anything else (the first `"version":` line is
 * not the top-level one) or the manifest does not parse, it returns the text
 * unchanged and warns: the shard then hashes the real version and only loses
 * cache hits across release bumps.
 * @param {string} text
 * @param {(message: string) => void} [warn]
 */
export function versionBlindManifest(text, warn = (m) => console.warn(`::warning title=test-cache::${m}`)) {
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    warn("package.json does not parse; hashing it unchanged");
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "string") return text;
  const out = text.replace(/^(\s*"version"\s*:\s*)"[^"\\\n]*"/m, `$1"${MANIFEST_VERSION_PLACEHOLDER}"`);
  let check;
  try { check = JSON.parse(out); } catch { check = null; }
  if (check?.version !== MANIFEST_VERSION_PLACEHOLDER ||
      JSON.stringify({ ...check, version: parsed.version }) !== JSON.stringify(parsed)) {
    warn("package.json version is not the first \"version\" line; hashing the manifest with its real version");
    return text;
  }
  return out;
}

/**
 * Browser jobs set TEST_CACHE_NORMALIZE_VERSION=1: their checkout's
 * package.json is rewritten before any hash is computed. The browser suite
 * runs against the mock backend, which reports its own version; nothing it
 * executes reads the manifest's version. Other tasks keep the real version.
 * @param {string} task
 * @param {Record<string, string | undefined>} env
 * @param {string} [workspace]
 */
function applyVersionBlindManifest(task, env, workspace = process.cwd()) {
  if (env.TEST_CACHE_NORMALIZE_VERSION !== "1" || !VERSION_BLIND_TASKS.has(task)) return;
  const file = join(workspace, "package.json");
  const text = readFileSync(file, "utf8");
  const blind = versionBlindManifest(text);
  if (blind !== text) {
    writeFileSync(file, blind);
    console.log(`Test-result cache: package.json version hashed as ${MANIFEST_VERSION_PLACEHOLDER} for ${task}`);
  }
}

/** @param {string} task @param {NodeJS.ProcessEnv} [sourceEnv] */
function turboEnv(task, sourceEnv = process.env) {
  const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args) =>
    execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: sourceEnv });
  const kinds = TASK_TOOLCHAINS[/** @type {keyof typeof TASK_TOOLCHAINS} */ (task)];
  if (!kinds) throw new Error(`test-cache: unknown task ${task}`);
  return {
    ...sourceEnv,
    TEST_CACHE_TOOLCHAIN: toolchainFingerprint(kinds, exec, sourceEnv.TEST_CACHE_APT_PACKAGES),
    TURBO_TELEMETRY_DISABLED: "1",
  };
}

/** @param {string} task @param {string} dir @param {{ read: boolean, write: boolean }} access */
const turboArgs = (task, dir, access) => [
  "run", task,
  `--cache=${cacheMode(access)}`,
  `--cache-dir=${dir}`,
  "--env-mode=loose",
  "--dangerously-disable-package-manager-check",
  "--ui=stream",
  // Turbo's auto order groups (buffers) task output on GitHub Actions, which
  // stamps every Playwright line with the task's end time: e2e-shards.mjs
  // record then reads zero durations, and a cancelled shard shows no tests.
  "--log-order=stream",
  "--log-prefix=none",
  "--output-logs=full",
];

/** @param {string} dir @param {number} now */
function prune(dir, now) {
  const files = readdirSync(dir).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
  for (const name of staleEntries(files, now, PRUNE_AFTER_MS)) rmSync(join(dir, name), { force: true });
}

/**
 * Turborepo's dry run with the same arguments and env as `run`.
 * @param {string} task
 * @param {{ read: boolean, write: boolean }} access
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [workspace]
 */
function dryRun(task, access, env, workspace = process.cwd()) {
  const dir = cacheDir(env);
  assertOutsideWorkspace(dir, workspace);
  const result = spawnSync(TURBO, [...turboArgs(task, dir, access), "--dry=json"], {
    encoding: "utf8", env, cwd: workspace, maxBuffer: 256 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stderr);
    return null;
  }
}

/** @param {Record<string, string>} opts */
function probe(opts) {
  const access = trust(process.env);
  const dir = cacheDir(process.env);
  assertOutsideWorkspace(dir, process.cwd());
  mkdirSync(dir, { recursive: true });
  const checkedAt = Date.now();
  prune(dir, checkedAt);
  // Execution must use this same cutoff: crossing the TTL between probe and
  // run must not turn a hit into a miss after dependency setup was skipped.
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `TEST_CACHE_PROBED_AT=${checkedAt}\n`);
  applyVersionBlindManifest(opts.task, process.env);
  const task = dryRun(opts.task, access, turboEnv(opts.task))?.tasks?.[0];
  const hash = task?.hash ?? "unknown";
  const hit = Boolean(task) && access.read && task.cache?.status === "HIT";
  console.log(`Test-result cache probe for ${opts.target}: ${hit ? "HIT" : "MISS"} (hash ${hash})`);
  setOutputs({ hit: String(hit), hash });
}

/**
 * Print what a target's hash covers, computed with the same env as CI, so a
 * suspected stale hit can be checked against the files the target reads.
 * @param {Record<string, string>} opts
 */
function explain(opts) {
  applyVersionBlindManifest(opts.task, process.env);
  const env = turboEnv(opts.task);
  const summary = dryRun(opts.task, { read: true, write: false }, env);
  if (!summary) throw new Error(`test-cache: Turborepo could not hash ${opts.task}`);
  const task = summary.tasks[0];
  console.log(JSON.stringify({
    task: task.taskId,
    hash: task.hash,
    toolchain: env.TEST_CACHE_TOOLCHAIN,
    env: task.environmentVariables,
    globalFiles: summary.globalCacheInputs.files,
    globalEnv: summary.globalCacheInputs.environmentVariables,
    files: task.inputs,
  }, null, 2));
}

/** @param {Record<string, string>} opts */
function run(opts) {
  const access = trust(process.env);
  const dir = cacheDir(process.env);
  assertOutsideWorkspace(dir, process.cwd());
  cacheKeys(process.env, opts.target);
  mkdirSync(dir, { recursive: true });
  const checkedAt = Number(process.env.TEST_CACHE_PROBED_AT);
  prune(dir, Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : Date.now());
  const runs = join(process.cwd(), ".turbo", "runs");
  const listRuns = () => { try { return new Set(readdirSync(runs)); } catch { return new Set(); } };
  const before = listRuns();
  applyVersionBlindManifest(opts.task, process.env);
  console.log(`Test-result cache: ${access.read ? "read" : "bypassed (read disabled)"}, ` +
    `${access.write ? "trusted run, passing results are stored" : "read-only run, nothing is stored"}`);
  const result = spawnSync(TURBO, [...turboArgs(opts.task, dir, access), "--summarize"], {
    stdio: "inherit", env: turboEnv(opts.task),
  });
  const status = result.status ?? 1;
  const summaryFile = [...listRuns()].find((f) => !before.has(f));
  if (!summaryFile) {
    console.error(`test-cache: Turborepo wrote no run summary for ${opts.task} (exit ${status})`);
    process.exit(status || 1);
  }
  const record = taskRecord(JSON.parse(readFileSync(join(runs, summaryFile), "utf8")), opts.target, access);
  const line = describeRecord(record);
  console.log(line);
  const out = reportDir(process.env);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${opts.target}.json`), `${JSON.stringify(record, null, 2)}\n`);
  addSummary(`- ${line}\n`);
  setOutputs({ cached: String(record.cached), stored: String(record.stored), hash: record.hash });
  process.exit(status);
}

/** @param {string} dir */
function report(dir) {
  /** @type {CacheRecord[]} */
  const records = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".json")) records.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    }
  } catch { /* no cached target ran */ }
  const markdown = formatReport(records);
  console.log(markdown);
  addSummary(markdown);
  const hits = records.filter((r) => r.cached).length;
  if (records.length) console.log(`::notice title=Test-result cache::${hits} of ${records.length} targets served from the cache`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...argv] = process.argv.slice(2);
  const { opts, rest } = parseArgs(argv);
  try {
    if (command === "key") {
      const { key, prefix } = cacheKeys(process.env, opts.target);
      const dir = cacheDir(process.env);
      console.log(`Test-result artifact key ${key} (trusted dev prefix ${prefix}) in ${dir}`);
      setOutputs({ key, prefix, dir });
    } else if (command === "restore") {
      try {
        const restored = await restoreCache(process.env, opts.target);
        console.log(`Trusted dev test-result artifact: ${restored ? "restored" : "unavailable (cache miss)"}`);
      } catch (error) {
        // Cache transport is optional; a failed download must execute tests.
        assertOutsideWorkspace(cacheDir(process.env), process.cwd());
        rmSync(cacheDir(process.env), { recursive: true, force: true });
        console.warn(`Test-result restore unavailable; running tests: ${error instanceof Error ? error.message : error}`);
      }
    } else if (command === "pack") pack(opts);
    else if (command === "probe") probe(opts);
    else if (command === "run") run(opts);
    else if (command === "explain") explain(opts);
    else if (command === "report") report(rest[0] ?? reportDir(process.env));
    else throw new Error("usage: test-cache.mjs key|restore|pack|probe|run|explain|report (see the header comment)");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
