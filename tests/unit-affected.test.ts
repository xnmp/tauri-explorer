import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadTestSources, selectUnit } from "../scripts/unit-affected.mjs";

const tests = [
  { rel: "tests/domain/zoom.test.ts", content: 'import { zoom } from "../../src/lib/domain/zoom";', scansDirs: false },
  { rel: "tests/ci-policy.test.ts", content: 'readFileSync(".github/workflows/ci.yml")', scansDirs: false },
  { rel: "tests/workflows.test.ts", content: 'readdirSync(new URL("../.github/workflows/", import.meta.url))', scansDirs: true },
  { rel: "tests/helpers/rust-source.ts", content: 'readFileSync("src-tauri/src/child_env.rs")', scansDirs: false },
];
const select = (changed: string[], { maxFiles = 50, deleted = [] as string[] } = {}) =>
  selectUnit(changed, tests, { maxFiles, exists: (f: string) => !deleted.includes(f) });

describe("selectUnit", () => {
  it("passes changed modules and tests to vitest related as a selected subset", () => {
    expect(select(["src/lib/domain/zoom.ts", "tests/domain/zoom.test.ts", "scripts/e2e-shards.mjs"])).toEqual({
      mode: "selected",
      reason: "tests related to 3 input(s) from 3 changed file(s)",
      items: ["scripts/e2e-shards.mjs", "src/lib/domain/zoom.ts", "tests/domain/zoom.test.ts"],
    });
  });

  it("selects tests and helpers that read a changed non-module file as text", () => {
    expect(select(["src-tauri/src/child_env.rs"]).items).toEqual(["tests/helpers/rust-source.ts"]);
    expect(select(["e2e-tauri/fixtures/README.md"]).mode).toBe("none");
  });

  it("selects a directory-scanning test for a new file in a directory it lists", () => {
    expect(select([".github/workflows/new-heavy.yml"]).items).toEqual(["tests/workflows.test.ts"]);
  });

  it("selects nothing when no change reaches a unit test", () => {
    expect(select(["docs/lessons/1-x.md", "evidence/ac-1.png"])).toEqual({
      mode: "none",
      reason: "none of 2 changed file(s) reaches a unit test",
      items: [],
    });
    expect(select([]).mode).toBe("none");
  });

  it.each([
    ["package.json", "config or lockfile change: package.json"],
    ["bun.lock", "config or lockfile change: bun.lock"],
    ["website/package.json", "config or lockfile change: website/package.json"],
    ["vitest.config.ts", "config or lockfile change: vitest.config.ts"],
    ["vitest.perf.config.ts", "config or lockfile change: vitest.perf.config.ts"],
    ["vite.config.ts", "config or lockfile change: vite.config.ts"],
    ["svelte.config.js", "config or lockfile change: svelte.config.js"],
    ["tsconfig.json", "config or lockfile change: tsconfig.json"],
    ["tests/setup.ts", "shared test setup, utility or fixture change: tests/setup.ts"],
    ["tests/serial-unit-files.ts", "shared test setup, utility or fixture change: tests/serial-unit-files.ts"],
    ["tests/helpers/drop-policy.ts", "shared test setup, utility or fixture change: tests/helpers/drop-policy.ts"],
    ["tests/perf/helpers.ts", "shared test setup, utility or fixture change: tests/perf/helpers.ts"],
    ["tests/fixtures/sidebar-cloud-mounts.json", "shared test setup, utility or fixture change: tests/fixtures/sidebar-cloud-mounts.json"],
    [".github/workflows/ci.yml", "CI test-selection change: .github/workflows/ci.yml"],
    ["scripts/unit-affected.mjs", "CI test-selection change: scripts/unit-affected.mjs"],
    ["scripts/test-selection.mjs", "CI test-selection change: scripts/test-selection.mjs"],
    ["turbo.json", "CI test-selection change: turbo.json"],
    ["scripts/test-cache.mjs", "CI test-selection change: scripts/test-cache.mjs"],
    ["scripts/ci-test-unit.sh", "CI test-selection change: scripts/ci-test-unit.sh"],
    ["src/lib/domain/removed.ts", "deleted module: src/lib/domain/removed.ts"],
    ["src-tauri/icons/icon.unknownext", "unknown file type: src-tauri/icons/icon.unknownext"],
    ["Makefile", "unknown file type: Makefile"],
    ["src/lib/odd name.ts", "a changed path contains unusual characters"],
  ])("runs the full suite for %s", (file, reason) => {
    expect(select(["src/lib/domain/zoom.ts", file], { deleted: ["src/lib/domain/removed.ts"] })).toEqual({
      mode: "all",
      reason,
      items: [],
    });
  });

  it("runs the full suite when more files changed than the limit", () => {
    const changed = ["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"];
    expect(select(changed, { maxFiles: 3 }).mode).toBe("selected");
    expect(select(changed, { maxFiles: 2 })).toEqual({
      mode: "all",
      reason: "3 changed files exceed the selection limit of 2",
      items: [],
    });
  });

  it("finds the repository's text readers of Rust sources and workflows", () => {
    const real = loadTestSources();
    expect(real.some((t) => t.rel === "tests/setup.ts")).toBe(true);
    expect(real.some((t) => t.rel.startsWith("tests/fixtures/"))).toBe(false);
    const sel = (f: string) => selectUnit([f], real, { maxFiles: 50 }).items;
    expect(sel("src-tauri/src/child_env.rs")).toContain("tests/child-env-compile.test.ts");
    expect(sel(".github/workflows/perf.yml")).toContain("tests/ci-trigger-policy.test.ts");
  });
});

describe("unit-affected CLI", () => {
  const run = (...args: string[]) =>
    JSON.parse(execFileSync("node", ["scripts/unit-affected.mjs", "--json", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));

  it("runs the full suite when the diff cannot be computed", () => {
    expect(run("--max-files", "50", "no-such-ref-1175", "HEAD")).toEqual({ mode: "all", reason: "selection failed", items: [] });
  });

  it("selects nothing for an empty diff", () => {
    expect(run("--max-files", "50", "HEAD", "HEAD")).toEqual({ mode: "none", reason: "no changed files", items: [] });
  });
});
