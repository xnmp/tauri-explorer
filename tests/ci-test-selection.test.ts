import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

// Runs ci.yml's own step scripts under bash with recording stubs for the test
// runners, so the PR/dev wiring and log lines are checked as CI executes them.
const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
type Step = { id?: string; name?: string; run?: string; if?: string; env?: Record<string, unknown> };
const step = (job: string, pick: (s: Step) => boolean): Step => {
  const found = (ci.jobs[job].steps as Step[]).find(pick);
  if (!found?.run) throw new Error(`no run step in ${job}`);
  return found;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-test-selection-"));
  for (const tool of ["bun", "bunx", "cargo", "npx", "xvfb-run"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\necho "${tool} $*" >> "${dir}/calls"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = () => {
  try { return readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch { return []; }
};

/** Run a step's script with GitHub expressions replaced by fixed values. */
function runStep(script: string, env: Record<string, string>, expressions: Record<string, string> = {}) {
  const resolved = script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => {
    if (!(expr in expressions)) throw new Error(`unresolved expression ${expr}`);
    return expressions[expr];
  });
  return execFileSync("bash", ["-e", "-c", resolved], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, "out"), GITHUB_STEP_SUMMARY: join(dir, "summary"), ...env },
  });
}

describe("changes job selection", () => {
  const select = step("changes", (s) => s.id === "select");

  it("caps selection at a documented number of changed files", () => {
    expect(ci.jobs.changes.env.TEST_SELECTION_MAX_FILES).toBe(50);
    expect(select.run).toContain('--max-files "$TEST_SELECTION_MAX_FILES"');
    expect(select.if).toBe("github.event_name == 'pull_request'");
  });

  it.each(["e2e", "unit", "rust"])("runs every %s test outside pull requests", (tier) => {
    const outputs = ci.jobs.changes.outputs;
    expect(outputs[tier]).toBe(`\${{ github.event_name == 'pull_request' && steps.select.outputs.${tier} || 'ALL' }}`);
    expect(outputs[`${tier}-reason`]).toContain("format('{0} event runs every test', github.event_name)");
  });

  it("publishes each selector's verdict and reason computed from the PR merge diff", () => {
    const outputs: Record<string, string> = {
      "e2e-affected": '{"mode":"selected","reason":"2 spec(s) from 3 changed file(s)","items":["e2e/a.spec.ts","e2e/b.spec.ts"]}',
      "unit-affected": '{"mode":"none","reason":"none of 3 changed file(s) reaches a unit test","items":[]}',
      "rust-affected": '{"mode":"all","reason":"workspace-wide Cargo change: src-tauri/Cargo.lock","items":[]}',
    };
    const node = Object.entries(outputs)
      .map(([name, json]) => `*${name}*) echo '${json}' ;;`)
      .join("\n");
    writeFileSync(join(dir, "node"), `#!/bin/bash\necho "node $*" >> "${dir}/calls"\ncase "$1" in\n${node}\nesac\n`);
    chmodSync(join(dir, "node"), 0o755);

    runStep(select.run as string, { TEST_SELECTION_MAX_FILES: "50" });

    expect(readFileSync(join(dir, "out"), "utf8").trim().split("\n")).toEqual([
      "e2e=e2e/a.spec.ts e2e/b.spec.ts",
      "e2e-reason=2 spec(s) from 3 changed file(s)",
      "unit=NONE",
      "unit-reason=none of 3 changed file(s) reaches a unit test",
      "rust=ALL",
      "rust-reason=workspace-wide Cargo change: src-tauri/Cargo.lock",
    ]);
    expect(calls()).toEqual([
      "node scripts/e2e-affected.mjs --strict --json --max-files 50 HEAD^1 HEAD",
      "node scripts/unit-affected.mjs --json --max-files 50 HEAD^1 HEAD",
      "node scripts/rust-affected.mjs --json --max-files 50 HEAD^1 HEAD",
    ]);
  });

  it("selects the full tier when a selector fails or prints garbage", () => {
    writeFileSync(join(dir, "node"), `#!/bin/bash\ncase "$1" in *unit*) echo 'not json' ;; *) exit 3 ;; esac\n`);
    chmodSync(join(dir, "node"), 0o755);

    runStep(select.run as string, { TEST_SELECTION_MAX_FILES: "50" });

    const out = readFileSync(join(dir, "out"), "utf8");
    for (const tier of ["e2e", "unit", "rust"]) {
      expect(out).toContain(`${tier}=ALL\n${tier}-reason=selection failed\n`);
    }
  });
});

describe("unit test step", () => {
  const unit = step("frontend-checks", (s) => s.name === "Unit tests");

  it("reads the selection from the changes job", () => {
    expect(unit.env).toEqual({
      UNIT_SELECTION: "${{ needs.changes.outputs.unit }}",
      UNIT_REASON: "${{ needs.changes.outputs.unit-reason }}",
    });
  });

  it("runs the full suite for ALL and says why", () => {
    const log = runStep(unit.run as string, { UNIT_SELECTION: "ALL", UNIT_REASON: "push event runs every test" });
    expect(log).toContain("Unit tests: full suite (push event runs every test)");
    expect(calls()).toEqual(["bun run test"]);
  });

  it("runs only tests related to the selected inputs, in both Vitest configs", () => {
    const log = runStep(unit.run as string, {
      UNIT_SELECTION: "src/lib/domain/zoom.ts tests/domain/zoom.test.ts",
      UNIT_REASON: "tests related to 2 input(s) from 2 changed file(s)",
    });
    expect(log).toContain("Unit tests: selected subset (tests related to 2 input(s) from 2 changed file(s))");
    expect(calls()).toEqual([
      "bunx vitest related --run --passWithNoTests src/lib/domain/zoom.ts tests/domain/zoom.test.ts",
      "bunx vitest related --run --passWithNoTests -c vitest.perf.config.ts src/lib/domain/zoom.ts tests/domain/zoom.test.ts",
    ]);
  });

  it("runs nothing for NONE and says why", () => {
    const log = runStep(unit.run as string, { UNIT_SELECTION: "NONE", UNIT_REASON: "none of 1 changed file(s) reaches a unit test" });
    expect(log).toContain("Unit tests: none selected (none of 1 changed file(s) reaches a unit test)");
    expect(calls()).toEqual([]);
  });
});

describe("Rust test step", () => {
  const job = ci.jobs["rust-suite"];
  const rust = step("rust-suite", (s) => s.name === "Rust tests");
  const features = { "matrix.test-features": "avif" };

  it("reads the selection from the changes job", () => {
    expect(job.env).toEqual({
      RUST_SELECTION: "${{ needs.changes.outputs.rust }}",
      RUST_REASON: "${{ needs.changes.outputs.rust-reason }}",
    });
  });

  it("runs the full workspace for ALL and says why", () => {
    const log = runStep(rust.run as string, { RUST_SELECTION: "ALL", RUST_REASON: "workspace-wide Cargo change: src-tauri/Cargo.lock" }, features);
    expect(log).toContain("Rust tests: full suite (workspace-wide Cargo change: src-tauri/Cargo.lock)");
    expect(calls()).toEqual(["cargo test --manifest-path src-tauri/Cargo.toml --features avif"]);
  });

  it("tests only the selected packages", () => {
    const log = runStep(rust.run as string, { RUST_SELECTION: "helper tauri-explorer", RUST_REASON: "changed crate(s) helper and their dependents" }, features);
    expect(log).toContain("Rust tests: selected packages helper tauri-explorer (changed crate(s) helper and their dependents)");
    expect(calls()).toEqual(["cargo test --manifest-path src-tauri/Cargo.toml --features avif -p helper -p tauri-explorer"]);
  });

  it("skips the toolchain, build and tests when nothing reaches Rust, and says why", () => {
    const log = runStep(rust.run as string, { RUST_SELECTION: "NONE", RUST_REASON: "none of 2 changed file(s) feeds a Rust crate" }, features);
    expect(log).toContain("Rust tests: none selected (none of 2 changed file(s) feeds a Rust crate)");
    expect(calls()).toEqual([]);
    const gated = (job.steps as Step[]).filter((s) => s.if?.includes("env.RUST_SELECTION != 'NONE'")).map((s) => s.name ?? s["uses" as keyof Step]);
    expect(gated).toEqual([
      "Install Tauri Linux system dependencies",
      "dtolnay/rust-toolchain@stable",
      "Swatinem/rust-cache@v2",
      "Create empty frontend dist",
      "Format check",
      "Clippy",
    ]);
  });
});

describe.each([
  ["chromium", "E2E tests", "E2E"],
  ["webkit-tests", "E2E tests (WebKit)", "WebKit E2E"],
])("%s browser step", (job, name, label) => {
  const e2e = step(job, (s) => s.name === name);

  it("runs its planned shard and states whether it is the full suite", () => {
    writeFileSync(join(dir, "e2e-shard.txt"), "e2e/a.spec.ts\ne2e/b.spec.ts\n");
    const log = runStep(e2e.run as string, { E2E_SELECTION: "ALL", E2E_REASON: "push event runs every test" }, { "steps.plan.outputs.run": "true" });
    expect(log).toContain(`${label}: full suite (push event runs every test), shard of 2 spec file(s)`);
    expect(calls().join("\n")).toContain("playwright test");
  });

  it("logs a selected subset with nothing left in this shard and runs nothing", () => {
    const log = runStep(e2e.run as string, { E2E_SELECTION: "e2e/a.spec.ts", E2E_REASON: "1 spec(s) from 1 changed file(s)" }, { "steps.plan.outputs.run": "false" });
    expect(log).toContain(`${label}: nothing to run in this shard; selected subset (1 spec(s) from 1 changed file(s))`);
    expect(calls()).toEqual([]);
  });
});
