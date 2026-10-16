#!/usr/bin/env node
// test-cache.mjs — CI test-result cache over Turborepo task hashing (#1176).
//
// Usage:
//   node scripts/test-cache.mjs key   --target <name>                 GitHub cache key, prefix and dir
//   node scripts/test-cache.mjs probe --task <ci:task> --target <name> hit=true|false before setup
//   node scripts/test-cache.mjs run   --task <ci:task> --target <name> run or replay the target
//   node scripts/test-cache.mjs report <dir>                          hit-rate summary of a run
//
// Turborepo computes each target's hash from the inputs and env vars turbo.json
// names, and replays a passing result for an unchanged hash; it never stores a
// failed task. This script only decides access and reports:
//   - CI sets TEST_CACHE_WRITE=true for dev pushes and same-repo PRs. Every
//     other run (fork PRs, manual runs, local machines) reads but never writes.
//   - TEST_CACHE_READ=false re-runs every target (bypass).
//   - The cache lives outside the checkout (RUNNER_TEMP), so files committed
//     in a PR can never be read as cache entries; ci.yml restores and saves it
//     with actions/cache, keyed by OS, architecture and runner image.
//   - TEST_CACHE_TOOLCHAIN (hashed via turbo.json's globalEnv) carries the
//     versions of the tools a target runs on.
// See .github/workflows/CLAUDE.md for detecting a stale hit and bypassing.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const CACHE_VERSION = "v1";
/** Entries unused for this long are dropped before a trusted save. */
export const PRUNE_AFTER_MS = 30 * 86_400_000;

/** The only runs whose results may be stored (ci.yml's TEST_CACHE_WRITE). */
export const TRUSTED_WRITE =
  "(github.event_name == 'push' && github.ref == 'refs/heads/dev') || " +
  "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)";

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
 * GitHub cache key for one target. Keys are immutable, so every run saves a
 * new key; restore-keys picks the newest entry sharing the platform prefix.
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
 * Cache files whose entry (all files sharing a hash) has gone unused too long.
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

/** @param {string} task */
function turboEnv(task) {
  const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args) =>
    execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const kinds = TASK_TOOLCHAINS[/** @type {keyof typeof TASK_TOOLCHAINS} */ (task)];
  if (!kinds) throw new Error(`test-cache: unknown task ${task}`);
  return {
    ...process.env,
    TEST_CACHE_TOOLCHAIN: toolchainFingerprint(kinds, exec, process.env.TEST_CACHE_APT_PACKAGES),
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
  "--log-prefix=none",
  "--output-logs=full",
];

/** @param {string} dir @param {number} now */
function prune(dir, now) {
  const files = readdirSync(dir).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
  for (const name of staleEntries(files, now, PRUNE_AFTER_MS)) rmSync(join(dir, name), { force: true });
}

/** @param {string} dir @param {string} hash */
function touch(dir, hash) {
  const now = new Date();
  for (const name of readdirSync(dir)) if (name.startsWith(hash)) utimesSync(join(dir, name), now, now);
}

/** @param {Record<string, string>} opts */
function probe(opts) {
  const access = trust(process.env);
  const dir = cacheDir(process.env);
  assertOutsideWorkspace(dir, process.cwd());
  const result = spawnSync(TURBO, [...turboArgs(opts.task, dir, access), "--dry=json"], {
    encoding: "utf8", env: turboEnv(opts.task), maxBuffer: 256 * 1024 * 1024,
  });
  let hash = "unknown";
  let hit = false;
  try {
    const task = JSON.parse(result.stdout).tasks[0];
    hash = task.hash;
    hit = access.read && task.cache?.status === "HIT";
  } catch {
    process.stderr.write(result.stderr);
  }
  console.log(`Test-result cache probe for ${opts.target}: ${hit ? "HIT" : "MISS"} (hash ${hash})`);
  setOutputs({ hit: String(hit), hash });
}

/** @param {Record<string, string>} opts */
function run(opts) {
  const access = trust(process.env);
  const dir = cacheDir(process.env);
  assertOutsideWorkspace(dir, process.cwd());
  cacheKeys(process.env, opts.target);
  mkdirSync(dir, { recursive: true });
  if (access.write) prune(dir, Date.now());
  const runs = join(process.cwd(), ".turbo", "runs");
  const listRuns = () => { try { return new Set(readdirSync(runs)); } catch { return new Set(); } };
  const before = listRuns();
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
  if (record.cached) touch(dir, record.hash);
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
      console.log(`Test-result cache key ${key} (restores the newest ${prefix}*) in ${dir}`);
      setOutputs({ key, prefix, dir });
    } else if (command === "probe") probe(opts);
    else if (command === "run") run(opts);
    else if (command === "report") report(rest[0] ?? reportDir(process.env));
    else throw new Error("usage: test-cache.mjs key|probe|run|report (see the header comment)");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
