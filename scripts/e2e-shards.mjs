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
//     estimated at the engine's median file duration.
//   node scripts/e2e-shards.mjs record run1.log [run2.log ...]
//     Rebuilds scripts/e2e-shard-timings.json from GitHub Actions logs
//     (`gh run view <id> --log > run.log`) of successful CI runs. The browser
//     jobs run one worker, so the gap between consecutive test-start lines of a
//     job is that test's duration; each file's per-run total is then the median
//     across the given runs.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(ROOT, "e2e");
export const TIMINGS_PATH = join(ROOT, "scripts/e2e-shard-timings.json");

// Playwright's default testMatch; playwright.config.ts does not override it.
const SPEC_FILE = /\.(spec|test)\.(c|m)?[jt]sx?$/;

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

// `<job>\t<step>\t<ISO time>Z ... [i/n] [engine] › [e2e/]file.spec.ts:line:col › title`
const TEST_START =
  /^([^\t]+)\t[^\t]*\t(\d{4}-\d\d-\d\dT[\d:.]+)Z\s.*?\[\d+\/\d+\] \[([\w-]+)\] › (?:e2e\/)?([^:\s]+):\d+/;
// The line reporter's closing summary bounds the job's final test.
const RUN_END = /^([^\t]+)\t[^\t]*\t(\d{4}-\d\d-\d\dT[\d:.]+)Z\s+\d+ passed\b/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\^\[\[[0-9;]*[A-Za-z]/g;

/**
 * Per-engine, per-file seconds observed in one GitHub Actions run log.
 * A test whose job has no later start line or closing summary (a cancelled or
 * truncated job) is not counted, rather than charged an unbounded duration.
 *
 * @param {string} log
 * @returns {Record<string, Record<string, number>>}
 */
export function parseCiLog(log) {
  /** @type {Map<string, { job: string, at: number, engine?: string, spec?: string }[]>} */
  const jobs = new Map();
  for (const raw of log.split("\n")) {
    const line = raw.replace(ANSI, "");
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
  for (const events of jobs.values()) {
    for (let i = 0; i + 1 < events.length; i++) {
      const { engine, spec, at } = events[i];
      if (!spec || !engine) continue;
      const seconds = Math.max(0, (events[i + 1].at - at) / 1000);
      totals[engine] ??= {};
      totals[engine][spec] = (totals[engine][spec] ?? 0) + seconds;
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

/** Spec files Playwright discovers under `dir`, relative to it, '/'-separated. */
export function discoverSpecs(dir = E2E_DIR) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SPEC_FILE.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((spec) => !spec.split("/").includes("node_modules"))
    .sort();
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
    if (!engine || !out) throw new Error("plan needs --engine <name> --shard i/n --out <file>");
    const { index, total } = parseShardArg(option(args, "--shard"));
    const timings = JSON.parse(readFileSync(TIMINGS_PATH, "utf8"))[engine] ?? {};
    const specs = discoverSpecs();
    const shard = planShards(specs, timings, total)[index - 1];
    if (shard.specs.length === 0) throw new Error(`shard ${index}/${total} has no spec files`);
    writeFileSync(out, `${shard.specs.join("\n")}\n`);
    const unknown = shard.specs.filter((spec) => !(spec in timings));
    process.stderr.write(
      `[e2e-shards] ${engine} shard ${index}/${total}: ${shard.specs.length} of ${specs.length} spec files, ` +
        `~${Math.round(shard.seconds / 60)} min estimated` +
        (unknown.length ? `; untimed (median estimate): ${unknown.join(", ")}` : "") +
        "\n",
    );
    return;
  }
  if (command === "record") {
    if (args.length === 0) throw new Error("record needs one or more GitHub Actions log files");
    const combined = combineRuns(args.map((file) => parseCiLog(readFileSync(file, "utf8"))));
    if (Object.keys(combined).length === 0) throw new Error("no Playwright test lines found in the given logs");
    writeFileSync(TIMINGS_PATH, `${JSON.stringify(combined, null, 1)}\n`);
    for (const [engine, files] of Object.entries(combined)) {
      const minutes = Object.values(files).reduce((sum, s) => sum + s, 0) / 60;
      process.stderr.write(`[e2e-shards] ${engine}: ${Object.keys(files).length} files, ${minutes.toFixed(1)} min\n`);
    }
    return;
  }
  throw new Error("usage: e2e-shards.mjs plan --engine <name> --shard i/n --out <file> | record <log...>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[e2e-shards] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
