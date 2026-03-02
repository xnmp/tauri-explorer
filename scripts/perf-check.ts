/**
 * Performance regression detection script.
 * Issue: tauri-explorer-9lnx
 *
 * Runs benchmarks, parses results, compares against baseline.
 * Exits non-zero if any metric regresses beyond threshold.
 *
 * Usage:
 *   npx tsx scripts/perf-check.ts              # Compare against baseline
 *   npx tsx scripts/perf-check.ts --update      # Update baseline with current results
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const BASELINE_PATH = resolve(import.meta.dirname ?? ".", "../perf-baseline.json");
const REGRESSION_THRESHOLD = 1.5; // 50% regression tolerance

interface BenchmarkEntry {
  name: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  iterations: number;
}

type Baseline = Record<string, BenchmarkEntry>;

/** Parse benchmark output lines like: "name: avg=0.03ms, min=0.01ms, max=0.21ms (200 iterations)" */
function parseBenchmarkOutput(output: string): BenchmarkEntry[] {
  const entries: BenchmarkEntry[] = [];
  const regex = /^(.+?):\s+avg=([\d.]+)ms,\s+min=([\d.]+)ms,\s+max=([\d.]+)ms\s+\((\d+)\s+iterations\)/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(regex);
    if (match) {
      entries.push({
        name: match[1],
        avgMs: parseFloat(match[2]),
        minMs: parseFloat(match[3]),
        maxMs: parseFloat(match[4]),
        iterations: parseInt(match[5], 10),
      });
    }
  }
  return entries;
}

function runBenchmarks(): BenchmarkEntry[] {
  console.log("Running benchmarks...\n");
  const output = execSync("npx vitest run tests/perf/ 2>&1", {
    encoding: "utf-8",
    timeout: 60000,
  });
  return parseBenchmarkOutput(output);
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
}

function saveBaseline(entries: BenchmarkEntry[]): void {
  const baseline: Baseline = {};
  for (const entry of entries) {
    baseline[entry.name] = entry;
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Baseline saved to ${BASELINE_PATH} (${entries.length} entries)`);
}

function compareResults(current: BenchmarkEntry[], baseline: Baseline): boolean {
  let hasRegression = false;

  console.log("Performance Comparison:\n");
  console.log(
    "%-40s %10s %10s %10s %s".replace(/%(-?\d*)s/g, (_, w) => {
      const width = parseInt(w) || 0;
      return `${"".padStart(Math.abs(width))}`;
    })
  );

  const header = [
    "Benchmark".padEnd(40),
    "Baseline".padStart(10),
    "Current".padStart(10),
    "Change".padStart(10),
    "Status",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const entry of current) {
    const base = baseline[entry.name];
    if (!base) {
      console.log(`${entry.name.padEnd(40)} ${"N/A".padStart(10)} ${entry.avgMs.toFixed(2).padStart(7)}ms ${"NEW".padStart(10)}`);
      continue;
    }

    const change = base.avgMs > 0 ? (entry.avgMs / base.avgMs - 1) * 100 : 0;
    const changeStr = `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
    const ratio = base.avgMs > 0 ? entry.avgMs / base.avgMs : 1;
    const isRegression = ratio > REGRESSION_THRESHOLD;
    const status = isRegression ? "REGRESSION" : "OK";

    if (isRegression) hasRegression = true;

    console.log(
      `${entry.name.padEnd(40)} ${base.avgMs.toFixed(2).padStart(7)}ms ${entry.avgMs.toFixed(2).padStart(7)}ms ${changeStr.padStart(10)} ${status}`
    );
  }

  console.log();
  return hasRegression;
}

// Main
const isUpdate = process.argv.includes("--update");
const entries = runBenchmarks();

if (entries.length === 0) {
  console.error("No benchmark results found.");
  process.exit(1);
}

console.log(`Found ${entries.length} benchmarks.\n`);

if (isUpdate) {
  saveBaseline(entries);
  process.exit(0);
}

const baseline = loadBaseline();
if (!baseline) {
  console.log("No baseline found. Run with --update to create one.");
  saveBaseline(entries);
  process.exit(0);
}

const hasRegression = compareResults(entries, baseline);
if (hasRegression) {
  console.error(`FAIL: Performance regression detected (>${(REGRESSION_THRESHOLD - 1) * 100}% slower)`);
  process.exit(1);
} else {
  console.log("PASS: No performance regressions detected.");
  process.exit(0);
}
