import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  combineRuns,
  discoverSpecs,
  parseCiLog,
  parseShardArg,
  planShards,
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

  it("matches the repository's e2e directory", () => {
    const specs = discoverSpecs();

    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((spec) => !spec.startsWith("e2e/") && /\.spec\.ts$/.test(spec))).toBe(true);
  });
});
