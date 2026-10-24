#!/usr/bin/env node
// e2e-shards.mjs — duration-balanced Playwright shards (#1123).
//
// Playwright's `--shard` splits by test count, so a shard that draws the heavy
// preview/theme/media specs runs ~1.8x longer than its siblings, and the slowest
// shard sets CI wall time. This plans whole spec files per shard from recorded
// per-file CI durations instead (greedy longest-first onto the least-loaded
// shard), and hands each shard to Playwright through `--test-list`.
//
// Usage:
//   node scripts/e2e-shards.mjs plan --engine webkit --shard 2/5 --out list.txt
//     Writes the shard's spec files (relative to e2e/) to list.txt for
//     `npx playwright test --test-list list.txt`. Every spec Playwright would
//     discover lands in exactly one shard; specs without a recorded timing are
//     estimated at the engine's median file duration. With --verify, the plan
//     is then listed through Playwright itself (project = engine) and the step
//     fails unless Playwright selects exactly the planned files: `--test-list`
//     silently selects nothing for an entry it cannot resolve (#1123).
//     With --only <file> (output of scripts/e2e-affected.mjs: "ALL" or one
//     "e2e/<spec>" per line), only those specs are planned and a shard may be
//     empty; the CI job then skips its install and test steps.
//   node scripts/e2e-shards.mjs verify --engine webkit --list list.txt
//     Lists the shard through Playwright itself (project = engine) and fails
//     unless it selects exactly the planned files (also `plan --verify`).
//   node scripts/e2e-shards.mjs record run1.log [run2.log ...]
//     Rebuilds scripts/e2e-shard-timings.json from GitHub Actions logs
//     (`gh run view <id> --log > run.log`) of successful CI runs. Each test
//     attempt's duration comes from its `[e2e-timing]` line
//     (scripts/e2e-timing-reporter.mjs), correct for any worker count. A job
//     without those lines (logs from before #1368's phase 2) falls back to
//     the gap between consecutive test-start lines, which is a duration only
//     with one worker; a multi-worker job without them is not timed. Each
//     file's per-run total is then the median across the given runs. Only
//     `chromium (N)` / `webkit-tests (N)` jobs that
//     executed (not cache replays) count; specs they did not time keep their
//     previous timing, and deleted specs are dropped. The weekly
//     e2e-shard-timings.yml workflow runs this against recent dev pushes.
//   node scripts/e2e-shards.mjs drift before.json
//     Prints a Markdown summary of how scripts/e2e-shard-timings.json differs
//     from before.json: per-engine totals and the largest per-spec changes.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(ROOT, "e2e");
export const TIMINGS_PATH = join(ROOT, "scripts/e2e-shard-timings.json");

// Playwright's default testMatch; playwright.config.ts does not override it.
export const SPEC_FILE = /\.(spec|test)\.(c|m)?[jt]sx?$/;

/** @param {number[]} values */
const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Partition spec files into `shardCount` shards balanced by estimated
 * duration. Deterministic for a given input; every spec appears exactly once.
 *
 * @param {readonly string[]} specs spec paths relative to the test directory
 * @param {Readonly<Record<string, number>>} timings seconds per spec path
 * @param {number} shardCount
 * @returns {{ specs: string[], seconds: number }[]}
 */
export function planShards(specs, timings, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shard count must be a positive integer, got ${shardCount}`);
  }
  const unique = [...new Set(specs)];
  const known = unique.map((spec) => timings[spec]).filter((s) => Number.isFinite(s) && s >= 0);
  const fallback = median(known) ?? 1;
  /** @param {string} spec */
  const estimate = (spec) => {
    const seconds = timings[spec];
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : fallback;
  };
  const ordered = unique
    .map((spec) => ({ spec, seconds: estimate(spec) }))
    .sort((a, b) => b.seconds - a.seconds || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
  /** @type {{ specs: string[], seconds: number }[]} */
  const shards = Array.from({ length: shardCount }, () => ({ specs: /** @type {string[]} */ ([]), seconds: 0 }));
  for (const { spec, seconds } of ordered) {
    let target = shards[0];
    for (const shard of shards) if (shard.seconds < target.seconds) target = shard;
    target.specs.push(spec);
    target.seconds += seconds;
  }
  for (const shard of shards) shard.specs.sort();
  return shards;
}

/**
 * Restrict discovered specs to an e2e-affected selection. A selection naming
 * `ALL` keeps every spec; otherwise the result is the listed specs that exist,
 * with the `e2e/` prefix removed.
 *
 * @param {readonly string[]} discovered spec paths relative to e2e/
 * @param {string} selection e2e-affected stdout
 * @returns {{ all: boolean, specs: string[] }}
 */
export function restrictSpecs(discovered, selection) {
  const lines = selection.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.includes("ALL")) return { all: true, specs: [...discovered] };
  const wanted = new Set(lines.map((line) => line.replace(/^e2e\//, "")));
  return { all: false, specs: discovered.filter((spec) => wanted.has(spec)) };
}

/**
 * Parse `"i/n"` into a 1-based index and a total.
 * @param {unknown} value
 */
export function parseShardArg(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value ?? ""));
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!(total >= 1 && index >= 1 && index <= total)) {
    throw new Error(`--shard must look like "i/n" with 1 <= i <= n, got ${value}`);
  }
  return { index, total };
}

// `<job>\t<step>\t<ISO time>Z ... [i/n] [engine] › [e2e/]file.spec.ts:line:col › title`;
// a retry prints `[i/n] (retries) [engine] › ...`.
const TEST_START =
  /^([^\t]+)\t[^\t]*\t(\d{4}-\d\d-\d\dT[\d:.]+)Z\s.*?\[\d+\/\d+\] (?:\(retries\) )?\[([\w-]+)\] › (?:e2e\/)?([^:\s]+):\d+/;
// The line reporter's closing summary bounds the job's final test.
const RUN_END = /^([^\t]+)\t[^\t]*\t(\d{4}-\d\d-\d\dT[\d:.]+)Z\s+\d+ passed\b/;
// One finished attempt, from scripts/e2e-timing-reporter.mjs.
const TIMING = /^[^\t]+\t[^\t]*\t\S+Z\s+\[e2e-timing\] ([\w-]+) (\S+) (\d+(?:\.\d+)?)\s*$/;
// Playwright's run header: "Running 416 tests using 2 workers".
const WORKERS = /\bRunning \d+ tests? using (\d+) workers?\b/;
// Only the default-mode browser shards time the plan; the ALL_VIEW_MODES job
// runs the same files several times over and would inflate them (#1367).
const SHARD_JOB = /^(chromium|webkit-tests) \(\d+\)$/;
// A shard served from the test-result cache replays its log instantly.
const CACHE_HIT = /: passed from the test-result cache\b/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\^\[\[[0-9;]*[A-Za-z]/g;

/**
 * Per-engine, per-file seconds observed in one GitHub Actions run log, summed
 * over every test attempt (retries included).
 * A job's `[e2e-timing]` lines are authoritative. Without them, a one-worker
 * job is timed by start-line gaps; a test whose job has no later start line or
 * closing summary (a cancelled or truncated job) is not counted, rather than
 * charged an unbounded duration, and a multi-worker job is not timed at all.
 * Only default-mode shard jobs count, and a job replayed from the test-result
 * cache counts not at all: its replayed lines carry no real durations.
 *
 * @param {string} log
 * @returns {Record<string, Record<string, number>>}
 */
export function parseCiLog(log) {
  /** @type {Map<string, { job: string, at: number, engine?: string, spec?: string }[]>} */
  const jobs = new Map();
  /** @type {Set<string>} */
  const replayed = new Set();
  /** @type {Map<string, { engine: string, spec: string, seconds: number }[]>} */
  const timed = new Map();
  /** @type {Map<string, number>} */
  const workers = new Map();
  for (const raw of log.split("\n")) {
    const line = raw.replace(ANSI, "");
    const job = line.slice(0, line.indexOf("\t"));
    if (!SHARD_JOB.test(job)) continue;
    if (CACHE_HIT.test(line)) { replayed.add(job); continue; }
    const timing = TIMING.exec(line);
    if (timing) {
      if (!timed.has(job)) timed.set(job, []);
      /** @type {NonNullable<ReturnType<typeof timed.get>>} */ (timed.get(job))
        .push({ engine: timing[1], spec: timing[2].replace(/^e2e\//, ""), seconds: Number(timing[3]) });
      continue;
    }
    const header = WORKERS.exec(line);
    if (header) { workers.set(job, Number(header[1])); continue; }
    const start = TEST_START.exec(line);
    const end = start ? null : RUN_END.exec(line);
    const event = start
      ? { job: start[1], at: Date.parse(`${start[2]}Z`), engine: start[3], spec: start[4] }
      : end
        ? { job: end[1], at: Date.parse(`${end[2]}Z`) }
        : null;
    if (!event || Number.isNaN(event.at)) continue;
    if (!jobs.has(event.job)) jobs.set(event.job, []);
    /** @type {NonNullable<ReturnType<typeof jobs.get>>} */ (jobs.get(event.job)).push(event);
  }
  /** @type {Record<string, Record<string, number>>} */
  const totals = {};
  const add = (/** @type {string} */ engine, /** @type {string} */ spec, /** @type {number} */ seconds) => {
    totals[engine] ??= {};
    totals[engine][spec] = Math.round(((totals[engine][spec] ?? 0) + seconds) * 1000) / 1000;
  };
  for (const [job, attempts] of timed) {
    if (replayed.has(job)) continue;
    for (const { engine, spec, seconds } of attempts) add(engine, spec, seconds);
  }
  for (const [job, events] of jobs) {
    // Start-line gaps are durations only for a one-worker job.
    if (replayed.has(job) || timed.has(job) || (workers.get(job) ?? 1) > 1) continue;
    for (let i = 0; i + 1 < events.length; i++) {
      const { engine, spec, at } = events[i];
      if (!spec || !engine) continue;
      add(engine, spec, Math.max(0, (events[i + 1].at - at) / 1000));
    }
  }
  return totals;
}

/**
 * Median of each engine/file across runs, rounded to 0.1 s, keys sorted.
 * @param {Record<string, Record<string, number>>[]} runs
 * @returns {Record<string, Record<string, number>>}
 */
export function combineRuns(runs) {
  /** @type {Record<string, Record<string, number[]>>} */
  const samples = {};
  for (const run of runs) {
    for (const [engine, files] of Object.entries(run)) {
      for (const [spec, seconds] of Object.entries(files)) {
        ((samples[engine] ??= {})[spec] ??= []).push(seconds);
      }
    }
  }
  /** @type {Record<string, Record<string, number>>} */
  const combined = {};
  for (const engine of Object.keys(samples).sort()) {
    combined[engine] = {};
    for (const spec of Object.keys(samples[engine]).sort()) {
      combined[engine][spec] = Math.round((median(samples[engine][spec]) ?? 0) * 10) / 10;
    }
  }
  return combined;
}

/**
 * Recorded timings for the specs that still exist, keeping a previous timing
 * for any spec the logs did not time (e.g. every shard holding it was a cache
 * hit), so the planner does not fall back to median estimates for it.
 * @param {Record<string, Record<string, number>>} previous
 * @param {Record<string, Record<string, number>>} recorded
 * @param {readonly string[]} discovered spec paths relative to e2e/
 */
export function mergeTimings(previous, recorded, discovered) {
  const exists = new Set(discovered);
  /** @type {Record<string, Record<string, number>>} */
  const merged = {};
  for (const engine of [...new Set([...Object.keys(previous), ...Object.keys(recorded)])].sort()) {
    const files = { ...previous[engine], ...recorded[engine] };
    merged[engine] = Object.fromEntries(Object.keys(files).filter((spec) => exists.has(spec)).sort()
      .map((spec) => [spec, files[spec]]));
  }
  return merged;
}

/**
 * How a recorded timings file differs from the previous one, per engine: the
 * summed minutes before and after, and the specs whose timing moved most.
 * @param {Record<string, Record<string, number>>} before
 * @param {Record<string, Record<string, number>>} after
 * @param {number} [top] specs listed per engine
 */
export function timingDrift(before, after, top = 10) {
  const minutes = (/** @type {Record<string, number>} */ files) =>
    Math.round(Object.values(files).reduce((sum, s) => sum + s, 0) / 6) / 10;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((engine) => {
    const a = before[engine] ?? {};
    const b = after[engine] ?? {};
    const changes = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .map((file) => ({ file, before: a[file] ?? null, after: b[file] ?? null }))
      .filter((c) => c.before !== c.after)
      .sort((x, y) => Math.abs((y.after ?? 0) - (y.before ?? 0)) - Math.abs((x.after ?? 0) - (x.before ?? 0)));
    return { engine, beforeMinutes: minutes(a), afterMinutes: minutes(b), changed: changes.length, largest: changes.slice(0, top) };
  });
}

/**
 * @param {ReturnType<typeof timingDrift>} drift
 * @returns {string}
 */
export function formatDrift(drift) {
  const lines = ["### E2E shard timing drift", ""];
  for (const d of drift) {
    lines.push(`**${d.engine}**: ${d.beforeMinutes} → ${d.afterMinutes} recorded minutes, ${d.changed} spec timing(s) changed`);
    if (d.largest.length > 0) {
      lines.push("", "| spec | before (s) | after (s) |", "|---|---|---|");
      for (const c of d.largest) lines.push(`| ${c.file} | ${c.before ?? "—"} | ${c.after ?? "—"} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Spec files Playwright discovers under `dir`, relative to it, '/'-separated. */
export function discoverSpecs(dir = E2E_DIR) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SPEC_FILE.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((spec) => !spec.split("/").includes("node_modules"))
    .sort();
}

/**
 * Spec files (relative to the test directory) that contain at least one test
 * in a Playwright JSON report, e.g. from `--list --reporter=json`.
 *
 * @param {{ suites?: unknown[] }} report
 * @returns {string[]}
 */
export function listedSpecFiles(report) {
  /** @type {Set<string>} */
  const files = new Set();
  /** @param {any} suite */
  const walk = (suite) => {
    if (typeof suite?.file === "string" && Array.isArray(suite.specs) && suite.specs.length > 0) files.add(suite.file);
    for (const child of Array.isArray(suite?.suites) ? suite.suites : []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return [...files].sort();
}

/**
 * Planned files Playwright did not select, and selected files that were not
 * planned. Both empty means the shard runs exactly its plan.
 *
 * @param {readonly string[]} planned
 * @param {readonly string[]} listed
 */
export function compareSelection(planned, listed) {
  const plannedSet = new Set(planned);
  const listedSet = new Set(listed);
  return {
    missing: [...plannedSet].filter((spec) => !listedSet.has(spec)).sort(),
    unexpected: [...listedSet].filter((spec) => !plannedSet.has(spec)).sort(),
  };
}

/**
 * @param {string} project
 * @param {string} listFile
 * @returns {string[]}
 */
function playwrightSelection(project, listFile) {
  const reportFile = `${listFile}.list.json`;
  try {
    const result = spawnSync(
      "npx",
      ["playwright", "test", `--project=${project}`, "--test-list", listFile, "--list", "--reporter=json"],
      { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile } },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`playwright --list exited with ${result.status ?? result.signal}`);
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    if (Array.isArray(report.errors) && report.errors.length > 0) {
      throw new Error(`playwright --list reported errors: ${JSON.stringify(report.errors).slice(0, 2000)}`);
    }
    return listedSpecFiles(report);
  } finally {
    rmSync(reportFile, { force: true });
  }
}

/**
 * @param {string[]} args
 * @param {string} name
 */
function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** @param {string[]} argv */
function main(argv) {
  const [command, ...args] = argv;
  if (command === "plan") {
    const engine = option(args, "--engine");
    const out = option(args, "--out");
    if (!engine || !out) throw new Error("plan needs --engine <name> --shard i/n --out <file> [--only <file>] [--verify]");
    const { index, total } = parseShardArg(option(args, "--shard"));
    const timings = JSON.parse(readFileSync(TIMINGS_PATH, "utf8"))[engine] ?? {};
    const only = option(args, "--only");
    const { all, specs } = only
      ? restrictSpecs(discoverSpecs(), readFileSync(only, "utf8"))
      : { all: true, specs: discoverSpecs() };
    const shard = planShards(specs, timings, total)[index - 1];
    // A full-suite shard can only be empty if planning is broken; a selected
    // subset legitimately leaves surplus shards with nothing to run.
    if (all && shard.specs.length === 0) throw new Error(`shard ${index}/${total} has no spec files`);
    writeFileSync(out, shard.specs.length ? `${shard.specs.join("\n")}\n` : "");
    const unknown = shard.specs.filter((spec) => !(spec in timings));
    process.stderr.write(
      `[e2e-shards] ${engine} shard ${index}/${total}: ${shard.specs.length} of ${specs.length} ${all ? "" : "selected "}spec files, ` +
        `~${Math.round(shard.seconds / 60)} min estimated` +
        (unknown.length ? `; untimed (median estimate): ${unknown.join(", ")}` : "") +
        "\n",
    );
    if (args.includes("--verify") && shard.specs.length > 0) {
      const { missing, unexpected } = compareSelection(shard.specs, playwrightSelection(engine, out));
      if (missing.length || unexpected.length) {
        throw new Error(
          `Playwright does not select exactly this shard's plan (missing: ${missing.join(", ") || "none"}; ` +
            `unexpected: ${unexpected.join(", ") || "none"})`,
        );
      }
      process.stderr.write(`[e2e-shards] verified: Playwright selects all ${shard.specs.length} planned files\n`);
    }
    return;
  }
  if (command === "verify") {
    const engine = option(args, "--engine");
    const list = option(args, "--list");
    if (!engine || !list) throw new Error("verify needs --engine <name> --list <file>");
    const planned = readFileSync(list, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    if (planned.length === 0) throw new Error(`${list} plans no spec files`);
    const { missing, unexpected } = compareSelection(planned, playwrightSelection(engine, list));
    if (missing.length || unexpected.length) {
      throw new Error(
        `Playwright does not select exactly this shard's plan (missing: ${missing.join(", ") || "none"}; ` +
          `unexpected: ${unexpected.join(", ") || "none"})`,
      );
    }
    process.stderr.write(`[e2e-shards] verified: Playwright selects all ${planned.length} planned files\n`);
    return;
  }
  if (command === "record") {
    if (args.length === 0) throw new Error("record needs one or more GitHub Actions log files");
    const recorded = combineRuns(args.map((file) => parseCiLog(readFileSync(file, "utf8"))));
    if (Object.keys(recorded).length === 0) throw new Error("no Playwright test lines found in the given logs");
    const previous = JSON.parse(readFileSync(TIMINGS_PATH, "utf8"));
    const combined = mergeTimings(previous, recorded, discoverSpecs());
    writeFileSync(TIMINGS_PATH, `${JSON.stringify(combined, null, 1)}\n`);
    for (const [engine, files] of Object.entries(combined)) {
      const minutes = Object.values(files).reduce((sum, s) => sum + s, 0) / 60;
      process.stderr.write(`[e2e-shards] ${engine}: ${Object.keys(files).length} files, ${minutes.toFixed(1)} min\n`);
    }
    return;
  }
  if (command === "drift" && args.length === 1) {
    const before = JSON.parse(readFileSync(args[0], "utf8"));
    const after = JSON.parse(readFileSync(TIMINGS_PATH, "utf8"));
    process.stdout.write(`${formatDrift(timingDrift(before, after))}\n`);
    return;
  }
  throw new Error("usage: e2e-shards.mjs plan --engine <name> --shard i/n --out <file> [--only <file>] [--verify] | verify --engine <name> --list <file> | record <log...> | drift <before.json>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[e2e-shards] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
