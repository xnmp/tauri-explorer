import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  combineRuns,
  compareSelection,
  discoverSpecs,
  formatDrift,
  listedSpecFiles,
  mergeTimings,
  parseCiLog,
  parseShardArg,
  planShards,
  restrictSpecs,
  timingDrift,
} from "../scripts/e2e-shards.mjs";

const flatten = (shards: { specs: string[] }[]) => shards.flatMap((shard) => shard.specs);
const slowest = (shards: { seconds: number }[]) => Math.max(...shards.map((shard) => shard.seconds));

describe("planShards", () => {
  it("assigns every spec to exactly one shard", () => {
    const specs = Array.from({ length: 23 }, (_, i) => `spec-${i}.spec.ts`);
    const timings = Object.fromEntries(specs.map((spec, i) => [spec, (i * 37) % 11 + 1]));
    const shards = planShards(specs, timings, 4);

    expect(shards).toHaveLength(4);
    expect(flatten(shards).sort()).toEqual([...specs].sort());
  });

  it("isolates a dominant file instead of pairing it by count", () => {
    // Count-based sharding would put heavy.spec.ts with two light files.
    const timings = { "heavy.spec.ts": 400, "a.spec.ts": 100, "b.spec.ts": 100, "c.spec.ts": 100, "d.spec.ts": 100, "e.spec.ts": 100 };
    const shards = planShards(Object.keys(timings), timings, 3);

    expect(shards.find((shard) => shard.specs.includes("heavy.spec.ts"))?.specs).toEqual(["heavy.spec.ts"]);
    expect(slowest(shards)).toBe(400);
  });

  it("keeps the slowest shard within the longest-first bound", () => {
    const specs = Array.from({ length: 60 }, (_, i) => `s${i}.spec.ts`);
    const timings = Object.fromEntries(specs.map((spec, i) => [spec, ((i * 7919) % 97) + 3]));
    const total = Object.values(timings).reduce((sum, s) => sum + s, 0);
    const shards = planShards(specs, timings, 5);

    // Greedy longest-first is within 4/3 of optimal, and optimal >= total/n.
    expect(slowest(shards)).toBeLessThanOrEqual((4 / 3) * Math.max(total / 5, Math.max(...Object.values(timings))));
    expect(shards.reduce((sum, shard) => sum + shard.seconds, 0)).toBeCloseTo(total);
  });

  it("estimates untimed specs at the median recorded duration and ignores stale entries", () => {
    const shards = planShards(
      ["a.spec.ts", "b.spec.ts", "c.spec.ts", "new.spec.ts"],
      { "a.spec.ts": 10, "b.spec.ts": 20, "c.spec.ts": 90, "deleted.spec.ts": 5000 },
      1,
    );

    expect(shards[0].seconds).toBe(10 + 20 + 90 + 20);
    expect(shards[0].specs).not.toContain("deleted.spec.ts");
  });

  it("treats malformed timings as untimed", () => {
    const shards = planShards(
      ["a.spec.ts", "b.spec.ts", "c.spec.ts"],
      { "a.spec.ts": 4, "b.spec.ts": Number.NaN, "c.spec.ts": -3 } as Record<string, number>,
      1,
    );

    expect(shards[0].seconds).toBe(12);
  });

  it("is independent of input order and duplicates", () => {
    const timings = { "x.spec.ts": 5, "y.spec.ts": 5, "z.spec.ts": 5, "w.spec.ts": 1 };
    const forward = planShards(["w.spec.ts", "x.spec.ts", "y.spec.ts", "z.spec.ts"], timings, 2);
    const reversed = planShards(["z.spec.ts", "y.spec.ts", "x.spec.ts", "x.spec.ts", "w.spec.ts"], timings, 2);

    expect(reversed).toEqual(forward);
  });

  it("falls back to equal weights when nothing is timed", () => {
    const shards = planShards(["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"], {}, 2);

    expect(shards.map((shard) => shard.specs.length)).toEqual([2, 2]);
  });

  it("leaves surplus shards empty rather than splitting a file", () => {
    const shards = planShards(["only.spec.ts"], { "only.spec.ts": 3 }, 3);

    expect(flatten(shards)).toEqual(["only.spec.ts"]);
    expect(shards.filter((shard) => shard.specs.length === 0)).toHaveLength(2);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects shard count %s", (count) => {
    expect(() => planShards(["a.spec.ts"], {}, count)).toThrow(/positive integer/);
  });
});

describe("parseShardArg", () => {
  it("parses a 1-based shard", () => {
    expect(parseShardArg("2/5")).toEqual({ index: 2, total: 5 });
  });

  it.each(["0/3", "4/3", "1/0", "a/b", "2", "", undefined, "1/3/4", " 1/3"])("rejects %s", (value) => {
    expect(() => parseShardArg(value)).toThrow(/--shard/);
  });
});

const line = (job: string, time: string, text: string) => `${job}\tUNKNOWN STEP\t2026-10-13T${time}Z ${text}`;
const start = (job: string, time: string, n: number, engine: string, spec: string) =>
  line(job, time, `\u001b[1A\u001b[2K[${n}/9] [${engine}] › e2e/${spec}:12:3 › suite › title`);

describe("parseCiLog", () => {
  it("charges each test the gap to the next start in its own job", () => {
    const log = [
      start("webkit-tests (1)", "10:00:00.0000000", 1, "webkit", "a.spec.ts"),
      start("chromium (1)", "10:00:01.0000000", 1, "chromium", "a.spec.ts"),
      start("webkit-tests (1)", "10:00:04.5000000", 2, "webkit", "a.spec.ts"),
      start("chromium (1)", "10:00:03.0000000", 2, "chromium", "b.spec.ts"),
      start("webkit-tests (1)", "10:00:10.0000000", 3, "webkit", "b.spec.ts"),
      line("webkit-tests (1)", "10:00:13.0000000", "  3 passed (13.0s)"),
      line("chromium (1)", "10:00:09.0000000", "  1 flaky"),
      line("chromium (1)", "10:00:09.0000000", "  2 passed (8.0s)"),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({
      webkit: { "a.spec.ts": 10, "b.spec.ts": 3 },
      chromium: { "a.spec.ts": 2, "b.spec.ts": 6 },
    });
  });

  it("charges a retried test's attempts to its own file", () => {
    const log = [
      start("chromium (2)", "10:00:00.0000000", 1, "chromium", "flaky.spec.ts"),
      start("chromium (2)", "10:00:30.0000000", 2, "chromium", "other.spec.ts"),
      line("chromium (2)", "10:00:35.0000000", "[3/3] (retries) [chromium] › e2e/flaky.spec.ts:12:3 › suite › title (retry #1)"),
      line("chromium (2)", "10:00:45.0000000", "  2 passed (45.0s)"),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({ chromium: { "flaky.spec.ts": 40, "other.spec.ts": 5 } });
  });

  it("drops a final test that never finished in a cancelled job", () => {
    const log = [
      start("webkit-tests (2)", "10:00:00.0000000", 1, "webkit", "a.spec.ts"),
      start("webkit-tests (2)", "10:00:02.0000000", 2, "webkit", "b.spec.ts"),
      line("webkit-tests (2)", "10:30:00.0000000", "##[error]The operation was canceled."),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({ webkit: { "a.spec.ts": 2 } });
  });

  it("accepts spec paths without the e2e/ prefix and ignores unrelated lines", () => {
    const log = [
      line("rust", "10:00:00.0000000", "test result: ok. 3 passed; 0 failed"),
      line("webkit-tests (1)", "10:00:00.0000000", "[1/2] [webkit] › nested/a.spec.ts:1:1 › t"),
      line("webkit-tests (1)", "10:00:01.0000000", "garbage [x/y] [webkit] › nothing"),
      line("webkit-tests (1)", "10:00:05.0000000", "2 passed (5.0s)"),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({ webkit: { "nested/a.spec.ts": 5 } });
  });

  it("times only default-mode shard jobs that executed, not cache replays or the view-mode job (#1367)", () => {
    const log = [
      start("chromium (1)", "10:00:00.0000000", 1, "chromium", "a.spec.ts"),
      line("chromium (1)", "10:00:04.0000000", "  1 passed (4.0s)"),
      start("chromium (2)", "10:00:00.0000000", 1, "chromium", "b.spec.ts"),
      line("chromium (2)", "10:00:00.0000000", "  1 passed (9.0s)"),
      line("chromium (2)", "10:00:00.0000000", "chromium-2: passed from the test-result cache (hash ab12; saved 9m 1s)"),
      start("chromium-view-modes (1)", "10:00:00.0000000", 1, "chromium", "a.spec.ts"),
      line("chromium-view-modes (1)", "10:01:00.0000000", "  1 passed (60.0s)"),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({ chromium: { "a.spec.ts": 4 } });
  });

  it("times a multi-worker job by its reported attempt durations, not interleaved starts (#1368)", () => {
    const timing = (job: string, time: string, engine: string, spec: string, seconds: string) =>
      line(job, time, `[e2e-timing] ${engine} ${spec} ${seconds}`);
    // Two workers: a.spec.ts runs 0-20 s while b.spec.ts runs 1-4 s and 4-9 s.
    const log = [
      line("chromium (1)", "10:00:00.0000000", "Running 3 tests using 2 workers"),
      start("chromium (1)", "10:00:00.0000000", 1, "chromium", "a.spec.ts"),
      start("chromium (1)", "10:00:01.0000000", 2, "chromium", "b.spec.ts"),
      timing("chromium (1)", "10:00:04.0000000", "chromium", "b.spec.ts", "3.00"),
      start("chromium (1)", "10:00:04.0000000", 3, "chromium", "b.spec.ts"),
      timing("chromium (1)", "10:00:09.0000000", "chromium", "b.spec.ts", "5.00"),
      timing("chromium (1)", "10:00:20.0000000", "chromium", "nested/a.spec.ts", "20.00"),
      line("chromium (1)", "10:00:20.0000000", "  3 passed (20.0s)"),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({ chromium: { "b.spec.ts": 8, "nested/a.spec.ts": 20 } });
  });

  it("does not time a multi-worker job from start-line gaps when it has no attempt durations", () => {
    const log = [
      line("chromium (1)", "10:00:00.0000000", "Running 2 tests using 2 workers"),
      start("chromium (1)", "10:00:00.0000000", 1, "chromium", "a.spec.ts"),
      start("chromium (1)", "10:00:01.0000000", 2, "chromium", "b.spec.ts"),
      line("chromium (1)", "10:00:20.0000000", "  2 passed (20.0s)"),
      line("webkit-tests (1)", "10:00:00.0000000", "Running 1 test using 1 worker"),
      start("webkit-tests (1)", "10:00:00.0000000", 1, "webkit", "c.spec.ts"),
      line("webkit-tests (1)", "10:00:07.0000000", "  1 passed (7.0s)"),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({ webkit: { "c.spec.ts": 7 } });
  });

  it("ignores attempt durations replayed from the test-result cache", () => {
    const log = [
      line("chromium (2)", "10:00:00.0000000", "[e2e-timing] chromium a.spec.ts 9.00"),
      line("chromium (2)", "10:00:00.0000000", "chromium-2: passed from the test-result cache (hash ab12; saved 9m 1s)"),
    ].join("\n");

    expect(parseCiLog(log)).toEqual({});
  });

  it("returns nothing for an empty or unrelated log", () => {
    expect(parseCiLog("")).toEqual({});
    expect(parseCiLog("just\nsome\ntext")).toEqual({});
  });
});

describe("combineRuns", () => {
  it("takes the per-file median across runs and keeps files seen in any run", () => {
    const combined = combineRuns([
      { webkit: { "a.spec.ts": 10, "b.spec.ts": 4 } },
      { webkit: { "a.spec.ts": 30 } },
      { webkit: { "a.spec.ts": 20.04 }, chromium: { "a.spec.ts": 1 } },
    ]);

    expect(combined).toEqual({ chromium: { "a.spec.ts": 1 }, webkit: { "a.spec.ts": 20, "b.spec.ts": 4 } });
  });
});

describe("discoverSpecs", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds spec files Playwright would match, nested, '/'-separated and sorted", () => {
    dir = mkdtempSync(join(tmpdir(), "e2e-shards-"));
    mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    for (const file of [
      "b.spec.ts",
      "a.test.mjs",
      "helpers.ts",
      "fixtures.spec.json",
      "nested/deeper/c.spec.tsx",
      "node_modules/pkg/d.spec.ts",
    ]) {
      writeFileSync(join(dir, file), "");
    }

    expect(discoverSpecs(dir)).toEqual(["a.test.mjs", "b.spec.ts", "nested/deeper/c.spec.tsx"]);
  });

  it("returns paths relative to the repository's e2e directory", () => {
    const specs = discoverSpecs();

    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((spec) => !spec.startsWith("e2e/") && /\.(spec|test)\.(c|m)?[jt]sx?$/.test(spec))).toBe(true);
  });
});

describe("listedSpecFiles", () => {
  it("collects files with at least one test from nested suites of a JSON report", () => {
    const report = {
      suites: [
        { title: "a.spec.ts", file: "a.spec.ts", specs: [], suites: [{ title: "group", file: "a.spec.ts", specs: [{ title: "t" }] }] },
        { title: "empty.spec.ts", file: "empty.spec.ts", specs: [], suites: [] },
        { title: "nested/b.spec.ts", file: "nested/b.spec.ts", specs: [{ title: "t" }, { title: "u" }] },
      ],
    };

    expect(listedSpecFiles(report)).toEqual(["a.spec.ts", "nested/b.spec.ts"]);
  });

  it("returns nothing for a report without suites or with malformed entries", () => {
    expect(listedSpecFiles({})).toEqual([]);
    expect(listedSpecFiles({ suites: [null, 3, { file: 7, specs: [{}] }, { suites: "x" }] })).toEqual([]);
  });
});

describe("compareSelection", () => {
  it("accepts a selection that matches the plan exactly", () => {
    expect(compareSelection(["b.spec.ts", "a.spec.ts"], ["a.spec.ts", "b.spec.ts"])).toEqual({ missing: [], unexpected: [] });
  });

  it("reports planned files Playwright did not select, including an empty selection", () => {
    expect(compareSelection(["a.spec.ts", "b.spec.ts"], [])).toEqual({ missing: ["a.spec.ts", "b.spec.ts"], unexpected: [] });
  });

  it("reports selected files outside the plan", () => {
    expect(compareSelection(["a.spec.ts"], ["a.spec.ts", "z.spec.ts"])).toEqual({ missing: [], unexpected: ["z.spec.ts"] });
  });
});

describe("restrictSpecs", () => {
  const discovered = ["a.spec.ts", "b.spec.ts", "nested/c.spec.ts"];

  it("keeps every spec for an ALL selection", () => {
    expect(restrictSpecs(discovered, "ALL\n")).toEqual({ all: true, specs: discovered });
  });

  it("keeps listed specs that exist, accepting the e2e/ prefix", () => {
    expect(restrictSpecs(discovered, "e2e/b.spec.ts\n  e2e/nested/c.spec.ts\ne2e/gone.spec.ts\n")).toEqual({
      all: false,
      specs: ["b.spec.ts", "nested/c.spec.ts"],
    });
  });

  it("selects nothing for NONE or an empty selection", () => {
    expect(restrictSpecs(discovered, "NONE\n")).toEqual({ all: false, specs: [] });
    expect(restrictSpecs(discovered, "")).toEqual({ all: false, specs: [] });
  });

  it("treats ALL anywhere in the selection as the full suite", () => {
    expect(restrictSpecs(discovered, "e2e/a.spec.ts\nALL\n").all).toBe(true);
  });
});

describe("mergeTimings", () => {
  it("overrides recorded specs, keeps untimed existing ones and drops deleted ones", () => {
    const previous = { chromium: { "a.spec.ts": 1, "b.spec.ts": 2, "gone.spec.ts": 3 }, webkit: { "a.spec.ts": 5 } };
    const recorded = { chromium: { "a.spec.ts": 10, "new.spec.ts": 4 } };
    expect(mergeTimings(previous, recorded, ["a.spec.ts", "b.spec.ts", "new.spec.ts"])).toEqual({
      chromium: { "a.spec.ts": 10, "b.spec.ts": 2, "new.spec.ts": 4 },
      webkit: { "a.spec.ts": 5 },
    });
  });
});

describe("timingDrift", () => {
  const before = { chromium: { "a.spec.ts": 60, "b.spec.ts": 30, "gone.spec.ts": 12 }, webkit: { "a.spec.ts": 120 } };
  const after = { chromium: { "a.spec.ts": 90, "b.spec.ts": 30, "new.spec.ts": 6 }, webkit: { "a.spec.ts": 120 } };

  it("reports per-engine totals and the specs that moved most, including added and removed ones", () => {
    const [chromium, webkit] = timingDrift(before, after);
    expect(chromium).toMatchObject({ engine: "chromium", beforeMinutes: 1.7, afterMinutes: 2.1, changed: 3 });
    expect(chromium.largest.map((c) => c.file)).toEqual(["a.spec.ts", "gone.spec.ts", "new.spec.ts"]);
    expect(chromium.largest[1]).toEqual({ file: "gone.spec.ts", before: 12, after: null });
    expect(webkit).toMatchObject({ engine: "webkit", changed: 0, largest: [] });
  });

  it("handles an engine present on one side only and limits the listed specs", () => {
    const drift = timingDrift({}, { webkit: { "a.spec.ts": 1, "b.spec.ts": 2 } }, 1);
    expect(drift).toEqual([{ engine: "webkit", beforeMinutes: 0, afterMinutes: 0.1, changed: 2, largest: [{ file: "b.spec.ts", before: null, after: 2 }] }]);
  });

  it("formats a Markdown summary for the job summary", () => {
    const text = formatDrift(timingDrift(before, after));
    expect(text).toContain("**chromium**: 1.7 → 2.1 recorded minutes, 3 spec timing(s) changed");
    expect(text).toContain("| gone.spec.ts | 12 | — |");
    expect(text).toContain("**webkit**: 2 → 2 recorded minutes, 0 spec timing(s) changed");
  });
});

describe("e2e-shard-timings.yml", () => {
  const text = readFileSync(new URL("../.github/workflows/e2e-shard-timings.yml", import.meta.url), "utf8");
  const workflow = parse(text);

  it("publishes the refreshed file as an artifact with read-only permissions, never a branch or PR", () => {
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    const steps = workflow.jobs.refresh.steps as { uses?: string; run?: string; with?: Record<string, unknown> }[];
    const runs = steps.map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/git push|gh pr create|git commit/);
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({ name: "e2e-shard-timings", path: "scripts/e2e-shard-timings.json", "if-no-files-found": "error" });
    expect(runs).toContain("node scripts/e2e-shards.mjs drift");
  });

  it("fails with an error annotation when no successful dev run exists", () => {
    expect(text).toContain('if [ ! -s "$RUNNER_TEMP/runs.txt" ]; then');
    expect(text).toMatch(/::error title=No CI runs to record::[^\n]*\n\s*exit 1/);
  });
});
