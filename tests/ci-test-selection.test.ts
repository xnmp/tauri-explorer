import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const tool of ["bun", "bunx", "cargo", "npx", "xvfb-run", "node"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\necho "${tool} $*" >> "${dir}/calls"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = () => {
  try { return readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch { return []; }
};

/** Run a repository script under bash with the same recording stubs. */
function runScript(script: string, env: Record<string, string>) {
  return execFileSync("bash", [new URL(`../${script}`, import.meta.url).pathname], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, ...env },
  });
}

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

  it.each(["e2e", "webkit", "view-modes", "unit", "rust"])("runs every %s test outside pull requests", (tier) => {
    const outputs = ci.jobs.changes.outputs;
    expect(outputs[tier]).toBe(`\${{ github.event_name == 'pull_request' && steps.select.outputs.${tier} || 'ALL' }}`);
    expect(outputs[`${tier}-reason`]).toContain("format('{0} event runs every test', github.event_name)");
  });

  it("publishes each selector's verdict and reason computed from the PR merge diff", () => {
    const outputs: Record<string, string> = {
      "e2e-affected.mjs --strict": '{"mode":"selected","reason":"2 spec(s) from 3 changed file(s)","items":["e2e/a.spec.ts","e2e/b.spec.ts"]}',
      "e2e-affected.mjs --webkit": '{"mode":"selected","reason":"1 spec(s) from 3 changed file(s)","items":["e2e/a.spec.ts"]}',
      "e2e-affected.mjs --view-modes": '{"mode":"none","reason":"none of 3 changed file(s) reaches a browser spec","items":[]}',
      "unit-affected": '{"mode":"none","reason":"none of 3 changed file(s) reaches a unit test","items":[]}',
      "rust-affected": '{"mode":"all","reason":"workspace-wide Cargo change: src-tauri/Cargo.lock","items":[]}',
    };
    const node = Object.entries(outputs)
      .map(([name, json]) => `"scripts/${name}"*) echo '${json}' ;;`)
      .join("\n");
    writeFileSync(join(dir, "node"), `#!/bin/bash\necho "node $*" >> "${dir}/calls"\ncase "$*" in\n${node}\nesac\n`);
    chmodSync(join(dir, "node"), 0o755);

    runStep(select.run as string, { TEST_SELECTION_MAX_FILES: "50" });

    expect(readFileSync(join(dir, "out"), "utf8").trim().split("\n")).toEqual([
      "e2e=e2e/a.spec.ts e2e/b.spec.ts",
      "e2e-reason=2 spec(s) from 3 changed file(s)",
      "webkit=e2e/a.spec.ts",
      "webkit-reason=1 spec(s) from 3 changed file(s)",
      "view-modes=NONE",
      "view-modes-reason=none of 3 changed file(s) reaches a browser spec",
      "unit=NONE",
      "unit-reason=none of 3 changed file(s) reaches a unit test",
      "rust=ALL",
      "rust-reason=workspace-wide Cargo change: src-tauri/Cargo.lock",
    ]);
    expect(calls()).toEqual([
      "node scripts/e2e-affected.mjs --strict --json --max-files 50 HEAD^1 HEAD",
      "node scripts/e2e-affected.mjs --webkit --json --max-files 50 HEAD^1 HEAD",
      "node scripts/e2e-affected.mjs --view-modes --json --max-files 50 HEAD^1 HEAD",
      "node scripts/unit-affected.mjs --json --max-files 50 HEAD^1 HEAD",
      "node scripts/rust-affected.mjs --json --max-files 50 HEAD^1 HEAD",
    ]);
  });

  it("passes a downloaded impact map to the browser tiers only (#1368)", () => {
    const map = join(dir, "map.json");
    writeFileSync(map, "{}");
    writeFileSync(join(dir, "node"), `#!/bin/bash\necho "node $*" >> "${dir}/calls"\necho '{"mode":"all","reason":"r","items":[]}'\n`);
    chmodSync(join(dir, "node"), 0o755);
    runStep(select.run as string, { TEST_SELECTION_MAX_FILES: "50", IMPACT_MAP: map });
    expect(calls()).toEqual([
      `node scripts/e2e-affected.mjs --strict --impact-map=${map} --json --max-files 50 HEAD^1 HEAD`,
      `node scripts/e2e-affected.mjs --webkit --impact-map=${map} --json --max-files 50 HEAD^1 HEAD`,
      `node scripts/e2e-affected.mjs --view-modes --impact-map=${map} --json --max-files 50 HEAD^1 HEAD`,
      "node scripts/unit-affected.mjs --json --max-files 50 HEAD^1 HEAD",
      "node scripts/rust-affected.mjs --json --max-files 50 HEAD^1 HEAD",
    ]);
  });

  it("selects without a map when none was downloaded", () => {
    writeFileSync(join(dir, "node"), `#!/bin/bash\necho "node $*" >> "${dir}/calls"\necho '{"mode":"all","reason":"r","items":[]}'\n`);
    chmodSync(join(dir, "node"), 0o755);
    runStep(select.run as string, { TEST_SELECTION_MAX_FILES: "50", IMPACT_MAP: join(dir, "missing.json") });
    expect(calls().filter((c) => c.includes("--impact-map"))).toEqual([]);
  });

  describe("impact map download", () => {
    const fetch = step("changes", (s) => s.id === "impact");
    // `picked` is what scripts/impact-map-source.mjs prints; the downloaded
    // map records `commit` (empty: the producing run's head sha is used).
    const stubGh = (picked: string, commit = "") => {
      writeFileSync(join(dir, "gh"), `#!/bin/bash\necho "gh $*" >> "${dir}/calls"\ncase "$2" in download) mkdir -p "\${9}"; echo '{"commit":"${commit}"}' > "\${9}/e2e-impact-map.json" ;; esac\n`);
      chmodSync(join(dir, "gh"), 0o755);
      writeFileSync(join(dir, "git"), `#!/bin/bash\necho "git $*" >> "${dir}/calls"\n`);
      chmodSync(join(dir, "git"), 0o755);
      const node = process.execPath;
      writeFileSync(join(dir, "node"), `#!/bin/bash\nif [ "$1" = scripts/impact-map-source.mjs ]; then echo "node $*" >> "${dir}/calls"; printf '%s' '${picked}'; else exec "${node}" "$@"; fi\n`);
      chmodSync(join(dir, "node"), 0o755);
    };

    it("never fails the job and picks the map through the trusted-producer check", () => {
      expect(fetch.if).toBe("github.event_name == 'pull_request'");
      expect((fetch as { "continue-on-error"?: boolean })["continue-on-error"]).toBe(true);
      expect(fetch.run).toContain('node scripts/impact-map-source.mjs "$GITHUB_REPOSITORY"');
    });

    it("downloads the chosen map and fetches the commit the map records", () => {
      stubGh("7 42 abc123", "def456");
      runStep(fetch.run as string, { GITHUB_REPOSITORY: "o/r" });
      // The stubbed node reads no map, so its server kind is unknown (#1391).
      expect(readFileSync(join(dir, "out"), "utf8").trim()).toBe(`map=${dir}/impact-map/e2e-impact-map.json\nserver=unknown`);
      expect(calls()).toEqual(expect.arrayContaining([
        "node scripts/impact-map-source.mjs o/r",
        `gh run download 42 --repo o/r -n e2e-impact-map -D ${dir}/impact-map`,
        "git fetch --no-tags --depth=1 origin def456",
      ]));
    });

    it("falls back to the producing run's commit for a map without one", () => {
      stubGh("7 42 abc123");
      runStep(fetch.run as string, { GITHUB_REPOSITORY: "o/r" });
      expect(calls()).toContain("git fetch --no-tags --depth=1 origin abc123");
    });

    it("publishes no map when no run exists", () => {
      stubGh("");
      runStep(fetch.run as string, { GITHUB_REPOSITORY: "o/r" });
      expect(existsSync(join(dir, "out"))).toBe(false);
      expect(readFileSync(join(dir, "summary"), "utf8")).toContain("none available");
    });
  });

  it("selects the full tier when a selector fails or prints garbage", () => {
    writeFileSync(join(dir, "node"), `#!/bin/bash\ncase "$1" in *unit*) echo 'not json' ;; *) exit 3 ;; esac\n`);
    chmodSync(join(dir, "node"), 0o755);

    runStep(select.run as string, { TEST_SELECTION_MAX_FILES: "50" });

    const out = readFileSync(join(dir, "out"), "utf8");
    for (const tier of ["e2e", "webkit", "view-modes", "unit", "rust"]) {
      expect(out).toContain(`${tier}=ALL\n${tier}-reason=selection failed\n`);
    }
  });
});

describe("dev-push impact map (#1386)", () => {
  it("records coverage on both Chromium jobs for dev pushes only, the runs that publish", () => {
    for (const job of ["chromium", "chromium-view-modes"]) {
      expect(ci.jobs[job].env.E2E_COVERAGE).toBe("${{ github.event_name == 'push' && github.ref == 'refs/heads/dev' && 'function' || '' }}");
    }
    expect(ci.jobs["webkit-tests"].env.E2E_COVERAGE).toBeUndefined();
  });

  it("cannot fail the run: the map is advisory and a dev push's conclusion gates releases", () => {
    expect(ci.jobs["impact-map"]["continue-on-error"]).toBe(true);
    // No gate or other job waits on it.
    for (const [name, job] of Object.entries(ci.jobs as Record<string, { needs?: string | string[] }>)) {
      if (name !== "impact-map") expect([job.needs ?? []].flat()).not.toContain("impact-map");
    }
  });

  it("expects one report per Chromium shard", () => {
    const shards = (job: string) => (ci.jobs[job].strategy.matrix.shard as number[]).length;
    expect(ci.jobs["impact-map"].env.EXPECTED_REPORTS).toBe(shards("chromium") + shards("chromium-view-modes"));
    expect(ci.jobs["impact-map"].needs).toEqual(["chromium", "chromium-view-modes"]);
    expect(ci.jobs["impact-map"].if).toContain("github.ref == 'refs/heads/dev'");
  });

  it("publishes nothing unless every shard reported", () => {
    const merge = step("impact-map", (s) => s.id === "merge");
    mkdirSync(join(dir, "records/impact-records-chromium-1/records"), { recursive: true });
    writeFileSync(join(dir, "records/impact-records-chromium-1/report-chromium-1.json"), "{}");
    const log = runStep(merge.run as string, { EXPECTED_REPORTS: "3", GITHUB_SHA: "abc" });
    expect(log).toContain("1 of 3 shard reports");
    expect(existsSync(join(dir, "out"))).toBe(false);
    expect(calls().some((c) => c.includes("impact-coverage.mjs merge"))).toBe(false);
  });

  it("adds the JSON report to coverage runs only", () => {
    runScript("scripts/ci-test-e2e.sh", { E2E_ENGINE: "chromium", E2E_SHARD_SPECS: "e2e/a.spec.ts", E2E_COVERAGE: "function", PLAYWRIGHT_JSON_OUTPUT_FILE: "/tmp/r.json" });
    expect(calls().at(-1)).toMatch(/--reporter=line,html,\.\/scripts\/e2e-timing-reporter\.mjs,json$/);
  });
});

describe("unit test step", () => {
  const unit = step("frontend-checks", (s) => s.name === "Unit tests");

  it("reads the selection from the changes job", () => {
    // Restore and execution both need the selection before hashing inputs.
    expect(ci.jobs["frontend-checks"].env).toEqual({
      UNIT_SELECTION: "${{ needs.changes.outputs.unit }}",
      UNIT_REASON: "${{ needs.changes.outputs.unit-reason }}",
    });
  });

  // The step says why, then runs scripts/ci-test-unit.sh through the cache.
  const cached = "node scripts/test-cache.mjs run --task ci:unit --target unit";

  it("runs the full suite for ALL and says why", () => {
    const log = runStep(unit.run as string, { UNIT_SELECTION: "ALL", UNIT_REASON: "push event runs every test" });
    expect(log).toContain("Unit tests: full suite (push event runs every test)");
    expect(calls()).toEqual([cached]);
    runScript("scripts/ci-test-unit.sh", { UNIT_SELECTION: "ALL" });
    expect(calls()).toEqual([cached, "bun run test"]);
  });

  it("runs only tests related to the selected inputs, in both Vitest configs", () => {
    const selection = "src/lib/domain/zoom.ts tests/domain/zoom.test.ts";
    const log = runStep(unit.run as string, {
      UNIT_SELECTION: selection,
      UNIT_REASON: "tests related to 2 input(s) from 2 changed file(s)",
    });
    expect(log).toContain("Unit tests: selected subset (tests related to 2 input(s) from 2 changed file(s))");
    expect(calls()).toEqual([cached]);
    runScript("scripts/ci-test-unit.sh", { UNIT_SELECTION: selection });
    expect(calls()).toEqual([
      cached,
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
  const features = { "matrix.suite": "default" };
  const cached = "node scripts/test-cache.mjs run --task ci:rust --target rust-default";
  const suite = { RUST_SUITE: "default", RUST_CLIPPY_FEATURES: "avif", RUST_TEST_FEATURES: "avif" };
  const lint = [
    "cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check",
    "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features avif -- -D warnings",
  ];

  it("reads the selection from the changes job", () => {
    expect(job.env).toMatchObject({
      RUST_SELECTION: "${{ needs.changes.outputs.rust }}",
      RUST_REASON: "${{ needs.changes.outputs.rust-reason }}",
      RUST_SUITE: "${{ matrix.suite }}",
      RUST_CLIPPY_FEATURES: "${{ matrix.clippy-features }}",
      RUST_TEST_FEATURES: "${{ matrix.test-features }}",
    });
  });

  it("runs the full workspace for ALL and says why", () => {
    const log = runStep(rust.run as string, { RUST_SELECTION: "ALL", RUST_REASON: "workspace-wide Cargo change: src-tauri/Cargo.lock" }, features);
    expect(log).toContain("Rust tests: full suite (workspace-wide Cargo change: src-tauri/Cargo.lock)");
    expect(calls()).toEqual([cached]);
    runScript("scripts/ci-test-rust.sh", { ...suite, RUST_SELECTION: "ALL" });
    expect(calls()).toEqual([cached, ...lint, "cargo test --manifest-path src-tauri/Cargo.toml --features avif"]);
  });

  it("tests only the selected packages", () => {
    const log = runStep(rust.run as string, { RUST_SELECTION: "helper tauri-explorer", RUST_REASON: "changed crate(s) helper and their dependents" }, features);
    expect(log).toContain("Rust tests: selected packages helper tauri-explorer (changed crate(s) helper and their dependents)");
    expect(calls()).toEqual([cached]);
    runScript("scripts/ci-test-rust.sh", { ...suite, RUST_SELECTION: "helper tauri-explorer" });
    expect(calls()).toEqual([cached, ...lint, "cargo test --manifest-path src-tauri/Cargo.toml --features avif -p helper -p tauri-explorer"]);
  });

  it("formats only in the default suite and lints with the suite's clippy features", () => {
    runScript("scripts/ci-test-rust.sh", {
      RUST_SUITE: "opt-in", RUST_CLIPPY_FEATURES: "avif,e2e-hooks", RUST_TEST_FEATURES: "avif", RUST_SELECTION: "ALL",
    });
    expect(calls()).toEqual([
      "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features avif,e2e-hooks -- -D warnings",
      "cargo test --manifest-path src-tauri/Cargo.toml --features avif",
    ]);
  });

  it("skips the whole job when nothing reaches Rust (#1368)", () => {
    expect(job.if).toBe("needs.changes.outputs.code == 'true' && needs.changes.outputs.rust != 'NONE'");
    // The job-level skip owns NONE: no step re-checks it.
    expect((job.steps as Step[]).filter((s) => s.if?.includes("RUST_SELECTION"))).toEqual([]);
    expect(rust.run).not.toContain("NONE");
    runScript("scripts/ci-test-rust.sh", { RUST_SUITE: "default", RUST_SELECTION: "NONE" });
    expect(calls()).toEqual([]);
  });
});

describe.each([
  ["chromium", "E2E tests", "chromium E2E", "chromium", "chromium"],
  ["chromium-view-modes", "E2E tests (all view modes)", "chromium ALL_VIEW_MODES E2E", "chromium", "chromium-view-modes"],
  ["webkit-tests", "E2E tests (WebKit)", "WebKit E2E", "webkit", "webkit"],
])("%s browser step", (job, name, label, engine, target) => {
  const e2e = step(job, (s) => s.name === name);

  const shard = { "steps.plan.outputs.run": "true", "matrix.shard": "2" };

  it("runs its planned shard through the cache and states whether it is the full suite", () => {
    writeFileSync(join(dir, "e2e-shard.txt"), "e2e/a.spec.ts\ne2e/b.spec.ts\n");
    const log = runStep(e2e.run as string, { E2E_SELECTION: "ALL", E2E_REASON: "push event runs every test" }, shard);
    expect(log).toContain(`${label}: full suite (push event runs every test), shard of 2 spec file(s)`);
    expect(calls()).toEqual([`node scripts/test-cache.mjs run --task ci:e2e --target ${target}-2`]);
    expect(ci.jobs[job].env.E2E_ENGINE).toBe(engine);
  });

  it("reads its own tier of the selection and skips itself when that is NONE", () => {
    const selection = { chromium: "e2e", "chromium-view-modes": "view-modes", "webkit-tests": "webkit" }[job];
    expect(e2e.env).toMatchObject({ E2E_SELECTION: `\${{ needs.changes.outputs.${selection} }}` });
    expect(ci.jobs[job].if).toBe(
      "!cancelled() && needs.changes.result == 'success' && " +
        `needs.changes.outputs.code == 'true' && needs.changes.outputs.${selection} != 'NONE'`,
    );
  });

  it("serves the shared browser-test bundle when it arrived, else the dev server (#1381)", () => {
    expect(ci.jobs[job].needs).toEqual(["changes", "e2e-build"]);
    const build = (ci.jobs["e2e-build"].steps as Step[]).find((s) => s.name === "Build the browser-test bundle")!;
    expect(build).toMatchObject({ run: "bun run build", env: { E2E_BROWSER_BUILD: "1" } });
    const steps = ci.jobs[job].steps as { name?: string; run?: string; uses?: string }[];
    const names = steps.map((step) => step.name);
    // E2E_BUILD_DIR is hashed by the test-result cache, so it is set before the key.
    expect(names.indexOf("Choose the app server")).toBeLessThan(names.indexOf("Test-result cache key"));
    const choose = steps.find((step) => step.name === "Choose the app server")!.run as string;
    const dir = mkdtempSync(join(tmpdir(), "e2e-server-"));
    try {
      const env = join(dir, "env");
      const summary = join(dir, "summary");
      writeFileSync(env, "");
      writeFileSync(summary, "");
      const run = () => execFileSync("bash", ["-c", choose], {
        cwd: dir, env: { ...process.env, GITHUB_ENV: env, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8",
      });
      expect(run()).toContain("serving the Vite dev server instead");
      expect(readFileSync(env, "utf8")).toBe("");
      // The fallback is visible in the job summary, not only as an annotation.
      expect(readFileSync(summary, "utf8")).toMatch(/app server.*Vite dev server.*e2e-browser-build/);
      writeFileSync(summary, "");
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build/index.html"), "");
      expect(run()).toContain("serving the shared browser-test bundle");
      expect(readFileSync(env, "utf8")).toBe("E2E_BUILD_DIR=build\n");
      expect(readFileSync(summary, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies and runs exactly the shard's specs in the cached script", () => {
    runScript("scripts/ci-test-e2e.sh", { E2E_ENGINE: engine, E2E_SHARD_SPECS: "e2e/a.spec.ts\ne2e/b.spec.ts" });
    const [verify, run] = calls();
    expect(verify).toMatch(new RegExp(`^node scripts/e2e-shards.mjs verify --engine ${engine} --list \\S+$`));
    const list = verify.split(" ").at(-1) as string;
    const test = engine === "webkit"
      ? `xvfb-run -a --server-args=-screen 0 1920x1080x24 -nolisten tcp npx playwright test --project=webkit --test-list ${list} --reporter=line,html,./scripts/e2e-timing-reporter.mjs`
      : `npx playwright test --project=chromium --test-list ${list} --reporter=line,html,./scripts/e2e-timing-reporter.mjs`;
    expect(run).toBe(test);
    expect(existsSync(list)).toBe(false);
  });

  it("logs the full suite when the plan overrode a mismatched impact map (#1391)", () => {
    writeFileSync(join(dir, "e2e-shard.txt"), "e2e/a.spec.ts\n");
    const log = runStep(e2e.run as string, {
      E2E_SELECTION: "e2e/a.spec.ts", E2E_REASON: "1 spec(s) from 1 changed file(s)", E2E_SERVER_OVERRIDE: "map on another server",
    }, shard);
    expect(log).toContain(`${label}: full suite (map on another server), shard of 1 spec file(s)`);
  });

  it("logs a selected subset with nothing left in this shard and runs nothing", () => {
    const log = runStep(e2e.run as string, { E2E_SELECTION: "e2e/a.spec.ts", E2E_REASON: "1 spec(s) from 1 changed file(s)" }, { "steps.plan.outputs.run": "false", "matrix.shard": "2" });
    expect(log).toContain(`${label}: nothing to run in this shard; selected subset (1 spec(s) from 1 changed file(s))`);
    expect(calls()).toEqual([]);
  });
});

// #1391: a map recorded on one kind of app server does not prove the
// selection on the other (chunks vs per-module scripts), so such a shard
// plans every spec of its tier.
describe.each([["chromium", "e2e"], ["webkit-tests", "webkit"]] as const)("%s shard plan under the impact map's server kind", (job, tier) => {
  const plan = step(job, (s) => s.id === "plan");
  const planned = (env: Record<string, string>) => {
    runStep(plan.run as string, { E2E_SELECTION: "e2e/a.spec.ts", E2E_REASON: "1 spec(s) from 1 changed file(s)", GITHUB_ENV: join(dir, "env"), ...env },
      { "matrix.shard": "1", "strategy.job-total": "2" });
    return readFileSync(join(dir, "e2e-selection.txt"), "utf8");
  };

  it("reads the map's server kind and its own", () => {
    expect(plan.env).toMatchObject({
      IMPACT_SERVER: "${{ needs.changes.outputs.impact-server }}",
      APP_SERVER: "${{ steps.server.outputs.server }}",
      E2E_SELECTION: `\${{ needs.changes.outputs.${tier} }}`,
    });
    const names = (ci.jobs[job].steps as Step[]).map((s) => s.name);
    expect(names.indexOf("Choose the app server")).toBeLessThan(names.indexOf("Plan duration-balanced shard"));
    expect(ci.jobs.changes.outputs["impact-server"]).toBe("${{ github.event_name == 'pull_request' && steps.impact.outputs.server || '' }}");
  });

  it.each([
    ["bundle", "dev"], ["dev", "bundle"], ["unknown", "bundle"], ["unknown", "dev"], ["mixed", "bundle"], ["mixed", "dev"],
  ])("plans every spec when the map was recorded on %s and the shard serves %s", (mapServer, appServer) => {
    expect(planned({ IMPACT_SERVER: mapServer, APP_SERVER: appServer })).toBe("ALL\n");
    expect(readFileSync(join(dir, "env"), "utf8")).toContain(`E2E_SERVER_OVERRIDE=the impact map was recorded on the ${mapServer} app server`);
    expect(readFileSync(join(dir, "summary"), "utf8")).toContain(`recorded on the ${mapServer} app server, this shard serves the ${appServer} server`);
  });

  it.each([["bundle", "bundle"], ["dev", "dev"], ["", "bundle"], ["", "dev"]])(
    "keeps the selection when the map was recorded on '%s' and the shard serves %s",
    (mapServer, appServer) => {
      expect(planned({ IMPACT_SERVER: mapServer, APP_SERVER: appServer })).toBe("e2e/a.spec.ts\n");
    },
  );
});

describe("view-mode shard plan", () => {
  const plan = step("chromium-view-modes", (s) => s.id === "plan");

  it("expands ALL into every spec that iterates the view modes", () => {
    writeFileSync(join(dir, "node"), `#!/bin/bash\necho "node $*" >> "${dir}/calls"\ncase "$*" in *list-view-mode-specs*) echo e2e/a.spec.ts ;; esac\n`);
    chmodSync(join(dir, "node"), 0o755);
    runStep(plan.run as string, { E2E_SELECTION: "ALL", E2E_REASON: "push event runs every test", GITHUB_ENV: join(dir, "env") },
      { "matrix.shard": "1", "strategy.job-total": "2" });
    expect(calls()[0]).toBe("node scripts/e2e-affected.mjs --list-view-mode-specs");
    expect(readFileSync(join(dir, "e2e-selection.txt"), "utf8")).toBe("e2e/a.spec.ts\n");
  });
});

const gates: Record<string, { base: Record<string, string>; browser: [string, string] }> = {
  frontend: {
    base: { CHECKS_RESULT: "success", CHROMIUM_RESULT: "success", VIEW_MODES_RESULT: "success", E2E: "ALL", VIEW_MODES: "ALL" },
    browser: ["CHROMIUM_RESULT", "E2E"],
  },
  webkit: { base: { WEBKIT_RESULT: "success", WEBKIT: "ALL" }, browser: ["WEBKIT_RESULT", "WEBKIT"] },
  // The Rust suites are skipped for a NONE selection like a browser job (#1368).
  rust: { base: { RUST_RESULT: "success", RUST: "ALL" }, browser: ["RUST_RESULT", "RUST"] },
};

describe.each([
  ["frontend", "Require frontend validation and browser outcomes"],
  ["webkit", "Require all WebKit browser outcomes"],
  ["rust", "Require all Rust suite outcomes"],
])("%s gate", (gate, name) => {
  const check = step(gate, (s) => s.name === name);
  const { base, browser } = gates[gate];
  const passes = (env: Record<string, string>) => {
    try {
      runStep(check.run as string, { CHANGES_RESULT: "success", CODE: "true", ...base, ...env });
      return true;
    } catch {
      return false;
    }
  };

  it("requires every upstream job on a code change", () => {
    expect(passes({})).toBe(true);
    for (const result of ["failure", "cancelled", "skipped"]) expect(passes({ [browser[0]]: result })).toBe(false);
  });

  it("accepts a skipped browser job only when its selection is NONE", () => {
    expect(passes({ [browser[0]]: "skipped", [browser[1]]: "NONE" })).toBe(true);
    expect(passes({ [browser[0]]: "success", [browser[1]]: "NONE" })).toBe(false);
  });

  it("requires every job skipped on a docs-only change and a successful changes job", () => {
    const skipped = Object.fromEntries(Object.keys(base).filter((k) => k.endsWith("_RESULT")).map((k) => [k, "skipped"]));
    expect(passes({ CODE: "false", ...skipped })).toBe(true);
    expect(passes({ CODE: "false" })).toBe(false);
    expect(passes({ CHANGES_RESULT: "failure" })).toBe(false);
  });

  it("names the job that failed the gate", () => {
    let log = "";
    try {
      runStep(check.run as string, { CHANGES_RESULT: "success", CODE: "true", ...base, [browser[0]]: "cancelled" });
    } catch (error) {
      log = String((error as { stdout?: string }).stdout);
    }
    expect(log).toMatch(/::error title=\S+ cancelled::\S+ is cancelled, expected success/);
  });
});
