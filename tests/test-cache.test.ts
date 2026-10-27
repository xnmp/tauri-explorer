import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import * as cacheModule from "../scripts/test-cache.mjs";
import {
  TRUSTED_WRITE, assertOutsideWorkspace, cacheKeys, cacheMode, describeRecord, formatReport, staleEntries,
  taskRecord, toolchainFingerprint, trust,
} from "../scripts/test-cache.mjs";

// CI test-result cache (#1176): Turborepo hashes each target's inputs and
// replays passing results; scripts/test-cache.mjs decides who may read and
// write, keys the GitHub cache by platform, and reports what the cache served.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/test-cache.mjs");
const turbo = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8"));
const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));

const LINUX = { RUNNER_OS: "Linux", RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20261012.1" };
const TURBO = join(ROOT, "node_modules/.bin/turbo");

/** A scratch repository shaped like this one, for the real-Turborepo tests. */
const FIXTURE_FILES = [
  "tsconfig.json", "vite.config.ts", "svelte.config.js", "playwright.config.ts", "vitest.config.ts",
  "README.md", "CHANGELOG.md", "CLAUDE.md",
  "src/lib/a.ts", "static/favicon.png",
  "src-tauri/src/lib.rs", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json",
  "src-tauri/CLAUDE.md", "src-tauri/vendor/wry/PATCH.md",
  "tests/a.test.ts", "tests/fixtures/x.json", "tests/contract/fixtures/c.json",
  "e2e/a.spec.ts", "e2e-tauri/fixtures/doc.pdf", "e2e-tauri/specs/n.spec.ts",
  "scripts/e2e-shards.mjs", "scripts/e2e-shard-timings.json",
  "docs/guide.md", "docs/adr/0001-x.md", "docs/lessons/1-x.md",
  "website/index.html", "website/api/report.js", "website/bun.lock",
  "evidence/1-proof.png", ".github/workflows/ci.yml",
];

describe("cache access", () => {
  it("writes only when CI marks the run trusted, and reads unless bypassed", () => {
    expect(trust({})).toEqual({ read: true, write: false });
    expect(trust({ TEST_CACHE_WRITE: "true" })).toEqual({ read: true, write: true });
    expect(trust({ TEST_CACHE_WRITE: "false", TEST_CACHE_READ: "false" })).toEqual({ read: false, write: false });
    expect(trust({ TEST_CACHE_WRITE: "1" })).toEqual({ read: true, write: false });
  });

  it.each([
    [{ read: true, write: true }, "local:rw"],
    [{ read: true, write: false }, "local:r"],
    [{ read: false, write: true }, "local:w"],
    [{ read: false, write: false }, "local:"],
  ])("maps %o to Turborepo's --cache=%s", (access, mode) => {
    expect(cacheMode(access)).toBe(mode);
  });

  it("refuses a cache directory inside the checkout, where PR content could plant entries", () => {
    expect(() => assertOutsideWorkspace("/repo/.turbo/cache", "/repo")).toThrow(/inside the checkout/);
    expect(() => assertOutsideWorkspace("/repo", "/repo")).toThrow(/inside the checkout/);
    expect(() => assertOutsideWorkspace("/runner/_temp/turbo-test-cache", "/repo")).not.toThrow();
    expect(() => assertOutsideWorkspace("/repo-cache", "/repo")).not.toThrow();
  });
});

describe("cache keys", () => {
  it("scopes every key to OS, architecture and runner image", () => {
    const linux = cacheKeys({ ...LINUX, GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "2" }, "unit");
    expect(linux).toEqual({
      prefix: "test-cache-v3-Linux-X64-ubuntu24-20261012.1-unit-",
      key: "test-cache-v3-Linux-X64-ubuntu24-20261012.1-unit-7-2",
    });
    const variants = [
      { ...LINUX, RUNNER_OS: "Windows", ImageOS: "win25" },
      { ...LINUX, RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64", ImageOS: "macos15" },
      { ...LINUX, ImageVersion: "20261019.3" },
    ];
    for (const env of variants) {
      const other = cacheKeys(env, "unit");
      // Artifact names match by prefix: neither platform may restore the other's entries.
      expect(other.key.startsWith(linux.prefix)).toBe(false);
      expect(linux.key.startsWith(other.prefix)).toBe(false);
    }
  });

  it("keeps one target's prefix from matching another target's keys", () => {
    const one = cacheKeys(LINUX, "chromium-1");
    expect(cacheKeys(LINUX, "chromium-10").key.startsWith(one.prefix)).toBe(false);
  });

  it("rejects target names that could escape the key or report path", () => {
    expect(() => cacheKeys(LINUX, "../unit")).toThrow(/target/);
  });
});

describe("toolchain fingerprint", () => {
  const exec = (versions: Record<string, string>) => (cmd: string, args: string[]) => {
    const out = versions[[cmd, ...args].join(" ")];
    if (out === undefined) throw new Error(`${cmd} not found`);
    return out;
  };

  it("includes each requested tool's version and marks missing tools", () => {
    const fp = toolchainFingerprint(["bun", "node", "rust"], exec({
      "bun --version": "1.3.8\n",
      "node --version": "v24.1.0\n",
      "rustc -Vv": "rustc 1.90.0\nhost: x86_64-unknown-linux-gnu\n",
    }));
    expect(fp).toBe("bun 1.3.8 | node v24.1.0 | rustc 1.90.0 host: x86_64-unknown-linux-gnu | cargo -V: unavailable");
  });

  it("records the candidate version of each apt package before it is installed", () => {
    const policy = "nasm:\n  Installed: (none)\n  Candidate: 2.16.01-1build1\n  Version table:\n" +
      "libdav1d-dev:\n  Installed: (none)\n  Candidate: 1.4.1-1\n";
    const fp = toolchainFingerprint(["apt"], exec({ "apt-cache policy nasm libdav1d-dev": policy }), "nasm libdav1d-dev");
    expect(fp).toBe("apt nasm=2.16.01-1build1 libdav1d-dev=1.4.1-1");
  });
});

describe("run records and the report", () => {
  const summary = (cache: object, execution: object) => ({
    tasks: [{ taskId: "ci:unit", hash: "abc123", cache, execution }],
  });

  it("records a hit as passed from the cache with the time it saved", () => {
    const record = taskRecord(summary({ status: "HIT", timeSaved: 125_000 }, { startTime: 1, endTime: 2, exitCode: 0 }), "unit", { write: true });
    expect(record).toEqual({
      target: "unit", task: "ci:unit", hash: "abc123", cached: true, passed: true, stored: false,
      exitCode: 0, durationMs: 1, timeSavedMs: 125_000,
    });
    expect(describeRecord(record)).toBe("unit: passed from the test-result cache (hash abc123; saved 2m 5s)");
  });

  it("stores a passing miss only when the run may write", () => {
    const passed = summary({ status: "MISS", timeSaved: 0 }, { startTime: 0, endTime: 61_000, exitCode: 0 });
    expect(taskRecord(passed, "unit", { write: true }).stored).toBe(true);
    const untrusted = taskRecord(passed, "unit", { write: false });
    expect(untrusted.stored).toBe(false);
    expect(describeRecord(untrusted)).toBe("unit: ran and passed in 1m 1s (hash abc123); not stored, this run may not write the cache");
  });

  it("never stores a failure and says it will re-run", () => {
    const failed = taskRecord(summary({ status: "MISS", timeSaved: 0 }, { startTime: 0, endTime: 9_000, exitCode: 1 }), "unit", { write: true });
    expect(failed).toMatchObject({ cached: false, passed: false, stored: false, exitCode: 1 });
    expect(describeRecord(failed)).toBe("unit: FAILED after 9s (hash abc123); failures are never cached, so the next run re-runs it");
  });

  it("reports the hit rate, the targets served from the cache, and runner time", () => {
    const hit = taskRecord(summary({ status: "HIT", timeSaved: 120_000 }, { startTime: 0, endTime: 0, exitCode: 0 }), "unit", { write: true });
    const miss = taskRecord(summary({ status: "MISS", timeSaved: 0 }, { startTime: 0, endTime: 300_000, exitCode: 0 }), "rust-default", { write: true });
    const report = formatReport([miss, hit]);
    expect(report).toContain("**Hit rate: 1 of 2 targets (50%)**");
    expect(report).toContain("Served from cache: unit");
    expect(report).toContain("saved 2m 0s");
    expect(report).toContain("executed 5m 0s");
    expect(report).toMatch(/\| unit \| passed from cache \| `abc123` \|/);
    expect(report).toMatch(/\| rust-default \| ran, passed, stored \| `abc123` \|/);
  });

  it("says so when no target used the cache", () => {
    expect(formatReport([])).toContain("No test target used the cache in this run");
  });
});

describe("pruning", () => {
  it("drops whole entries older than the limit", () => {
    const day = 86_400_000;
    const now = 100 * day;
    const files = [
      { name: "aaa.tar.zst", mtimeMs: now - 40 * day },
      { name: "aaa-meta.json", mtimeMs: now - 40 * day },
      { name: "bbb.tar.zst", mtimeMs: now - 40 * day },
      { name: "bbb-meta.json", mtimeMs: now - 1 * day },
    ];
    expect(staleEntries(files, now, 30 * day)).toEqual(["aaa-meta.json", "aaa.tar.zst"]);
  });
});

// The real Turborepo, the real turbo.json and the real package.json wiring,
// against a scratch repository whose test scripts only count their runs.
describe("Turborepo task cache", () => {
  let fixture: string;
  let scratch: string;
  let cacheDir: string;
  let reportDir: string;
  let runsLog: string;
  let base: Record<string, string>;

  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(fixture, rel)), { recursive: true });
    writeFileSync(join(fixture, rel), content);
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: fixture });

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "test-cache-"));
    fixture = join(scratch, "repo");
    const shims = join(scratch, "bin");
    mkdirSync(shims);
    for (const [tool, body] of Object.entries({
      rustc: 'echo "rustc $FAKE_RUSTC"',
      cargo: 'echo "cargo $FAKE_RUSTC"',
      "apt-cache": 'for p in "$@"; do [ "$p" = policy ] || printf "%s:\\n  Installed: (none)\\n  Candidate: %s\\n" "$p" "$FAKE_APT"; done',
    })) {
      writeFileSync(join(shims, tool), `#!/bin/sh\n${body}\n`);
      chmodSync(join(shims, tool), 0o755);
    }
    mkdirSync(fixture);
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
    write("package.json", JSON.stringify({
      name: "fixture", private: true,
      scripts: { "ci:unit": scripts["ci:unit"], "ci:rust": scripts["ci:rust"], "ci:e2e": scripts["ci:e2e"] },
    }, null, 2));
    cpSync(join(ROOT, "turbo.json"), join(fixture, "turbo.json"));
    cpSync(join(ROOT, ".gitignore"), join(fixture, ".gitignore"));
    write("bun.lock", "{}\n");
    for (const [rel, script] of [
      ["scripts/ci-test-unit.sh", "ci:unit"], ["scripts/ci-test-rust.sh", "ci:rust"], ["scripts/ci-test-e2e.sh", "ci:e2e"],
    ]) {
      expect(scripts[script]).toBe(`bash ${rel}`);
      write(rel, `echo "${script}" >> "$RUNS_LOG"\necho "${script} output"\nexit "\${FAIL:-0}"\n`);
    }
    for (const rel of FIXTURE_FILES) write(rel, rel.endsWith(".json") ? "{}\n" : `// ${rel}\n`);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "fixture");
    runsLog = join(scratch, "runs.log");
    base = {
      PATH: `${shims}:${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: process.env.HOME ?? scratch,
      TURBO_TELEMETRY_DISABLED: "1",
      RUNS_LOG: runsLog,
      FAKE_RUSTC: "1.90.0",
      FAKE_APT: "2.16.01",
      TEST_CACHE_APT_PACKAGES: "nasm libdav1d-dev",
      ...LINUX,
      TEST_CACHE_WRITE: "true",
      UNIT_SELECTION: "ALL",
      RUST_SUITE: "default",
      RUST_SELECTION: "ALL",
      E2E_ENGINE: "chromium",
      E2E_SHARD_SPECS: "e2e/a.spec.ts",
    };
  }, 60_000);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  beforeEach(() => {
    git("checkout", "-q", "--", ".");
    git("clean", "-qfdx");
    cacheDir = mkdtempSync(join(scratch, "cache-"));
    reportDir = mkdtempSync(join(scratch, "report-"));
    rmSync(runsLog, { force: true });
  });

  const runs = () => (existsSync(runsLog) ? readFileSync(runsLog, "utf8").trim().split("\n") : []);
  /** Edit a fixture file, or create it if the fixture lacks it. */
  const change = (rel: string) => {
    if (rel === "package.json") {
      const manifest = JSON.parse(readFileSync(join(fixture, rel), "utf8"));
      write(rel, JSON.stringify({ ...manifest, version: "2.0.0" }));
    } else if (rel.endsWith(".json") || rel.endsWith(".lock")) {
      write(rel, '{"changed":true}\n');
    } else {
      write(rel, `${existsSync(join(fixture, rel)) ? readFileSync(join(fixture, rel), "utf8") : ""}# changed\n`);
    }
  };
  const cache = (task: string, target: string, env: Record<string, string> = {}) => {
    const out = join(scratch, "github-output");
    rmSync(out, { force: true });
    const result = spawnSync(process.execPath, [SCRIPT, "run", "--task", task, "--target", target], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...base, TEST_CACHE_DIR: cacheDir, TEST_CACHE_REPORT_DIR: reportDir, GITHUB_OUTPUT: out, ...env },
    });
    const reportFile = join(reportDir, `${target}.json`);
    return {
      status: result.status,
      log: `${result.stdout}${result.stderr}`,
      record: existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : undefined,
      outputs: existsSync(out) ? readFileSync(out, "utf8") : "",
    };
  };
  const probe = (task: string, target: string, env: Record<string, string> = {}) => {
    const out = join(scratch, "probe-output");
    rmSync(out, { force: true });
    spawnSync(process.execPath, [SCRIPT, "probe", "--task", task, "--target", target], {
      cwd: fixture, encoding: "utf8", env: { ...base, TEST_CACHE_DIR: cacheDir, GITHUB_OUTPUT: out, ...env },
    });
    return readFileSync(out, "utf8");
  };

  const publishedArchive = (seed: string, target: string, name: string) => {
    const packed = spawnSync(process.execPath, [SCRIPT, "pack", "--target", target], {
      cwd: fixture, encoding: "utf8", env: { ...base, RUNNER_TEMP: scratch, TEST_CACHE_DIR: seed, TEST_CACHE_REPORT_DIR: reportDir },
    });
    expect(packed.status, packed.stderr).toBe(0);
    const zip = join(scratch, `${name}.zip`);
    execFileSync("zip", ["-qr", zip, "."], { cwd: join(scratch, "test-cache-archive", target) });
    return zip;
  };

  it("uses the installed Turborepo binary", () => {
    expect(existsSync(TURBO)).toBe(true);
  });

  it("serves an unchanged passing target from the cache and reports it as passed", () => {
    const first = cache("ci:unit", "unit");
    expect(first.status).toBe(0);
    expect(first.record).toMatchObject({ cached: false, passed: true, stored: true });
    expect(first.outputs).toContain("stored=true");
    expect(probe("ci:unit", "unit")).toContain("hit=true");

    const second = cache("ci:unit", "unit");
    expect(second.status).toBe(0);
    expect(runs()).toEqual(["ci:unit"]);
    expect(second.record).toMatchObject({ cached: true, passed: true, stored: false, hash: first.record.hash });
    expect(second.log).toContain("unit: passed from the test-result cache");
    // The original output is replayed, so the log still shows what ran.
    expect(second.log).toContain("ci:unit output");
    expect(second.outputs).toContain("cached=true");
  }, 60_000);

  it.each([
    ["a source file", () => write("src/lib/a.ts", "export const changed = 1;\n"), {}],
    ["the lockfile", () => write("bun.lock", '{"changed":1}\n'), {}],
    ["the test config", () => {
      const config = JSON.parse(readFileSync(join(fixture, "turbo.json"), "utf8"));
      config.tasks["ci:unit"].outputs = ["coverage/**"];
      write("turbo.json", JSON.stringify(config));
    }, {}],
    ["the test script", () => write("scripts/ci-test-unit.sh", `echo "ci:unit" >> "$RUNS_LOG"\necho changed\n`), {}],
    ["the selected tests", () => {}, { UNIT_SELECTION: "src/lib/a.ts" }],
    ["the runner image", () => {}, { ImageVersion: "20261019.3" }],
    ["the operating system", () => {}, { RUNNER_OS: "Windows", ImageOS: "win25" }],
  ])("re-runs the unit target when %s changes", (_label, change, env: Record<string, string>) => {
    cache("ci:unit", "unit");
    change();
    const again = cache("ci:unit", "unit", env);
    expect(again.record).toMatchObject({ cached: false, passed: true });
    expect(runs()).toEqual(["ci:unit", "ci:unit"]);
  }, 60_000);

  it.each([
    ...["bun.lock", "package.json", "website/bun.lock", "vitest.config.ts", "tsconfig.json", "scripts/ci-test-unit.sh",
      "src-tauri/src/lib.rs"].map((f) => ["ci:unit", "unit", f]),
    ...["src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/.cargo/config.toml",
      "rust-toolchain.toml", ".cargo/config.toml", "scripts/ci-test-rust.sh", "tests/contract/fixtures/c.json",
      "e2e-tauri/fixtures/doc.pdf", "static/favicon.png", "src-tauri/vendor/wry/PATCH.md", "bun.lock",
    ].map((f) => ["ci:rust", "rust-default", f]),
    ...["bun.lock", "package.json", "playwright.config.ts", "vite.config.ts", "svelte.config.js", "tsconfig.json",
      "static/favicon.png", "scripts/ci-test-e2e.sh", "scripts/e2e-shards.mjs", "scripts/e2e-shard-timings.json",
      "tests/fixtures/x.json", "e2e-tauri/fixtures/doc.pdf",
    ].map((f) => ["ci:e2e", "chromium-1", f]),
  ])("re-runs %s (%s) when %s changes", (task, target, file) => {
    cache(task, target);
    change(file);
    expect(cache(task, target).record).toMatchObject({ cached: false, passed: true });
    expect(runs()).toEqual([task, task]);
  }, 60_000);

  it("re-runs the Rust target when the Rust toolchain or a system library changes", () => {
    cache("ci:rust", "rust-default");
    cache("ci:rust", "rust-default", { FAKE_RUSTC: "1.91.0" });
    cache("ci:rust", "rust-default", { FAKE_RUSTC: "1.91.0", FAKE_APT: "2.17.00" });
    cache("ci:rust", "rust-default", { FAKE_RUSTC: "1.91.0", FAKE_APT: "2.17.00", RUST_TEST_FEATURES: "avif" });
    expect(runs()).toEqual(["ci:rust", "ci:rust", "ci:rust", "ci:rust"]);
  }, 60_000);

  // Unit tests read ADRs, the README, workflows, website/api and Rust sources
  // as text contracts, so those files are inputs of the unit target.
  it.each([
    ["docs", "docs/guide.md", []],
    ["lessons", "docs/lessons/1-x.md", []],
    ["an ADR the unit tests read", "docs/adr/0001-x.md", ["ci:unit"]],
    ["the README the unit tests read", "README.md", ["ci:unit"]],
    // The version-only classifier names CHANGELOG.md (#1367).
    ["the changelog", "CHANGELOG.md", ["ci:unit"]],
    ["a folder CLAUDE.md", "src-tauri/CLAUDE.md", []],
    ["committed evidence", "evidence/1-proof.png", []],
    ["the website page", "website/index.html", []],
    ["the website API the unit tests import", "website/api/report.js", ["ci:unit"]],
    ["the frontend package", "src/lib/a.ts", ["ci:unit", "ci:e2e"]],
    ["the Rust package", "src-tauri/src/lib.rs", ["ci:unit", "ci:rust"]],
    ["a unit test", "tests/a.test.ts", ["ci:unit"]],
    ["a browser spec", "e2e/a.spec.ts", ["ci:unit", "ci:e2e"]],
    ["a native spec", "e2e-tauri/specs/n.spec.ts", ["ci:unit"]],
    ["the workflow", ".github/workflows/ci.yml", ["ci:unit"]],
    ["a shared test fixture", "tests/fixtures/x.json", ["ci:unit", "ci:rust", "ci:e2e"]],
  ])("a change to %s re-runs only the targets that read it", (_label, file, rerun) => {
    const targets = [["ci:unit", "unit"], ["ci:rust", "rust-default"], ["ci:e2e", "chromium-1"]];
    for (const [task, target] of targets) cache(task, target);
    rmSync(runsLog);
    change(file);
    git("commit", "-qam", "change");
    try {
      for (const [task, target] of targets) cache(task, target);
      expect(runs()).toEqual(rerun);
    } finally {
      git("reset", "-q", "--hard", "HEAD~1");
    }
  }, 60_000);

  it("re-runs a failed target on the next run instead of serving the failure", () => {
    const failed = cache("ci:unit", "unit", { FAIL: "3" });
    expect(failed.status).not.toBe(0);
    expect(failed.record).toMatchObject({ cached: false, passed: false, stored: false });
    expect(readdirSync(cacheDir)).toEqual([]);
    expect(probe("ci:unit", "unit")).toContain("hit=false");
    const retry = cache("ci:unit", "unit");
    expect(retry.record).toMatchObject({ cached: false, passed: true });
    expect(runs()).toEqual(["ci:unit", "ci:unit"]);
  }, 60_000);

  it("lets an untrusted run read stored results but never write new ones", () => {
    const untrusted = { TEST_CACHE_WRITE: "false" };
    const fork = cache("ci:unit", "unit", untrusted);
    expect(fork.record).toMatchObject({ cached: false, passed: true, stored: false });
    expect(readdirSync(cacheDir)).toEqual([]);
    cache("ci:unit", "unit", untrusted);
    expect(runs()).toEqual(["ci:unit", "ci:unit"]);

    cache("ci:unit", "unit");
    const read = cache("ci:unit", "unit", untrusted);
    expect(read.record).toMatchObject({ cached: true, passed: true });
    expect(runs()).toHaveLength(3);
  }, 60_000);

  it.each(["true", "false"])("expires a passing entry before setup is decided (write=%s)", (writeAccess) => {
    // Model CI's probe -> conditional dependency setup -> execution contract.
    // The command fails if a miss executes before its dependency is installed.
    write("scripts/ci-test-e2e.sh", 'test -f "$DEPENDENCY" || exit 7\necho executed >> "$RUNS_LOG"\n');
    const dependency = join(scratch, "browser-installed");
    writeFileSync(dependency, "installed");
    const env = { TEST_CACHE_WRITE: writeAccess, DEPENDENCY: dependency };
    expect(cache("ci:e2e", "chromium-1", { ...env, TEST_CACHE_WRITE: "true" }).status).toBe(0);
    rmSync(dependency);
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const name of readdirSync(cacheDir)) utimesSync(join(cacheDir, name), old, old);
    const output = probe("ci:e2e", "chromium-1", env);
    if (output.includes("hit=false")) writeFileSync(dependency, "installed");
    const executed = cache("ci:e2e", "chromium-1", env);
    expect(output).toContain("hit=false");
    expect(executed.status).toBe(0);
    expect(executed.record).toMatchObject({ cached: false, passed: true });
    expect(runs()).toEqual(["executed", "executed"]);
  }, 60_000);

  it("keeps a probed hit valid if expiration is crossed while setup is skipped", () => {
    const first = cache("ci:e2e", "chromium-1");
    const now = Date.now();
    const almostExpired = new Date(now - cacheModule.PRUNE_AFTER_MS + 5_000);
    for (const name of readdirSync(cacheDir)) utimesSync(join(cacheDir, name), almostExpired, almostExpired);
    const envFile = join(scratch, "github-env");
    writeFileSync(envFile, "");
    expect(probe("ci:e2e", "chromium-1", { GITHUB_ENV: envFile })).toContain("hit=true");
    const checkedAt = readFileSync(envFile, "utf8").match(/TEST_CACHE_PROBED_AT=(\d+)/)?.[1];
    expect(checkedAt).toBeDefined();
    // Simulate crossing the TTL after the probe without sleeping for 5s:
    // make the entry stale now, but still valid at the recorded probe cutoff.
    const edge = new Date(Number(checkedAt) - cacheModule.PRUNE_AFTER_MS + 1);
    for (const name of readdirSync(cacheDir)) utimesSync(join(cacheDir, name), edge, edge);
    const result = cache("ci:e2e", "chromium-1", { TEST_CACHE_PROBED_AT: checkedAt! });
    expect(result.record).toMatchObject({ cached: true, passed: true, hash: first.record.hash });
    expect(runs()).toEqual(["ci:e2e"]);
  }, 60_000);

  it.each([
    ["same-repo PR", { event: "pull_request" }, false],
    ["fork PR", { event: "pull_request", head_repository: { full_name: "attacker/fork" } }, false],
    ["fork push", { head_repository: { full_name: "attacker/fork" } }, false],
    ["manual run", { event: "workflow_dispatch" }, false],
    ["main push", { head_branch: "main" }, false],
    ["failed dev push with a passing target", { conclusion: "failure" }, true],
    ["protected dev push", {}, true],
  ])("restores a passing entry only with trusted run ownership: %s", async (_label, overrides, allowed) => {
    // Produce a real passing Turborepo entry, as malicious PR code could do.
    const forged = mkdtempSync(join(scratch, "forged-"));
    expect(cache("ci:unit", "unit", { TEST_CACHE_DIR: forged }).status).toBe(0);
    const created = new Date(Date.now() - 2 * 86_400_000);
    for (const name of readdirSync(forged)) utimesSync(join(forged, name), created, created);
    const zip = publishedArchive(forged, "unit", "forged");
    const downloaded: string[] = [];
    const env = { ...base, GITHUB_REPOSITORY: "xnmp/tauri-explorer", GH_TOKEN: "read-only", TEST_CACHE_DIR: cacheDir, TEST_CACHE_WRITE: "true" };
    const prefix = cacheKeys(env, "unit").prefix;
    const fetchApi = async (url: string | URL | Request) => {
      const path = String(url);
      downloaded.push(path);
      if (path.includes("/workflows/ci.yml/runs?")) return Response.json({ workflow_runs: [
        { id: 9, event: "push", head_branch: "dev", conclusion: "success", head_repository: { full_name: env.GITHUB_REPOSITORY },
          status: "completed", run_attempt: 1, path: ".github/workflows/ci.yml", head_sha: "same-input", ...overrides },
      ] });
      if (path.endsWith("/zip")) return new Response(readFileSync(zip));
      if (path.includes("/artifacts")) return Response.json({ artifacts: [{ id: 99, name: `trusted-${prefix}9-1`, expired: false }] });
      return new Response(readFileSync(zip));
    };
    expect(await cacheModule.restoreCache(env, "unit", fetchApi, fixture)).toBe(allowed);
    if (allowed) {
      for (const name of readdirSync(cacheDir)) {
        expect(statSync(join(cacheDir, name)).mtimeMs).toBeLessThan(Date.now() - 86_400_000);
      }
    }
    const result = cache("ci:unit", "unit", { TEST_CACHE_WRITE: "false", FAIL: "3" });
    // A forged pass must never conceal the failing command on a later run.
    expect(result.status === 0).toBe(allowed);
    expect(result.record).toMatchObject({ cached: allowed, passed: allowed });
    expect(downloaded.some((url) => url.includes("/artifacts/99/zip"))).toBe(allowed);
  }, 60_000);

  it.each([
    ["in-progress rerun", "in_progress", false, {}, true, {}],
    ["queued rerun", "queued", false, {}, true, {}],
    ["failed current rerun", "completed", false, {}, true, {}],
    ["older rerun outside the discovery window", "in_progress", true, {}, true, {}],
    ["failed previous attempt with a passing target", "in_progress", false, { conclusion: "failure" }, true, {}],
    ["unfinished previous attempt", "in_progress", false, { status: "in_progress" }, false, {}],
    ["previous attempt from a PR", "in_progress", false, { event: "pull_request" }, false, {}],
    ["previous attempt from a fork", "in_progress", false, { head_repository: { full_name: "attacker/fork" } }, false, {}],
    ["previous attempt from another workflow", "in_progress", false, { path: ".github/workflows/other.yml" }, false, {}],
    ["previous attempt for another input", "in_progress", false, { head_sha: "different-input" }, false, {}],
    ["previous attempt with a mismatched number", "in_progress", false, { run_attempt: 2 }, false, {}],
    ["current PR outside the discovery window", "in_progress", true, {}, false, { event: "pull_request" }],
    ["different current workflow outside the discovery window", "in_progress", true, {}, false, { path: ".github/workflows/other.yml" }],
  ])("verifies previous-attempt results: %s", async (_label, status, outsideWindow, overrides, allowed, currentOverrides) => {
    const seed = mkdtempSync(join(scratch, "previous-attempt-"));
    const first = cache("ci:unit", "unit", { TEST_CACHE_DIR: seed });
    expect(first.status).toBe(0);
    const zip = publishedArchive(seed, "unit", "previous-attempt");
    const env = {
      ...base, GITHUB_REPOSITORY: "xnmp/tauri-explorer", GH_TOKEN: "read-only", TEST_CACHE_DIR: cacheDir,
      GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "2",
    };
    const producer = {
      id: 9, event: "push", head_branch: "dev", head_repository: { full_name: env.GITHUB_REPOSITORY },
      path: ".github/workflows/ci.yml", head_sha: "same-input", run_attempt: 2, status,
      conclusion: status === "completed" ? "failure" : null, ...currentOverrides,
    };
    const requested: string[] = [];
    const fetchApi = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path.endsWith("/workflows/ci.yml/runs")) {
        // GitHub's conclusion-filtered listing hides a currently running rerun.
        const hidden = outsideWindow || new URL(String(url)).searchParams.get("status") === "success";
        return Response.json({ workflow_runs: hidden ? [] : [producer] });
      }
      if (path.endsWith("/actions/runs/9")) return Response.json(producer);
      if (path.endsWith("/attempts/1")) return Response.json({
        ...producer, run_attempt: 1, status: "completed", conclusion: "success", ...overrides,
      });
      if (path.endsWith("/artifacts")) return Response.json({ artifacts: [
        { id: 99, name: `trusted-${cacheKeys(env, "unit").prefix}9-1`, expired: false },
      ] });
      if (path.endsWith("/artifacts/99/zip")) return new Response(readFileSync(zip));
      throw new Error(`Unexpected API request: ${path}`);
    };
    expect(await cacheModule.restoreCache(env, "unit", fetchApi, fixture)).toBe(allowed);
    const result = cache("ci:unit", "unit", { TEST_CACHE_WRITE: "false", FAIL: "3" });
    expect(result.status === 0).toBe(allowed);
    expect(result.record).toMatchObject({ cached: allowed, passed: allowed, hash: first.record.hash });
    // The replay must skip the command, whose second execution would fail.
    expect(runs()).toHaveLength(allowed ? 1 : 2);
    expect(requested.includes("/repos/xnmp/tauri-explorer/actions/runs/9/attempts/1"))
      .toBe(Object.keys(currentOverrides).length === 0);
    expect(requested.includes("/repos/xnmp/tauri-explorer/actions/artifacts/99/zip")).toBe(allowed);
  }, 60_000);

  it("reuses the passing target when another target made the attempt fail", async () => {
    const seed = mkdtempSync(join(scratch, "passing-target-"));
    expect(cache("ci:unit", "unit", { TEST_CACHE_DIR: seed }).status).toBe(0);
    const archive = publishedArchive(seed, "unit", "passing-target");
    const failed = cache("ci:e2e", "chromium-1", { FAIL: "3" });
    expect(failed.record).toMatchObject({ passed: false, stored: false });
    const rejected = spawnSync(process.execPath, [SCRIPT, "pack", "--target", "chromium-1"], {
      cwd: fixture, encoding: "utf8", env: { ...base, RUNNER_TEMP: scratch, TEST_CACHE_DIR: cacheDir, TEST_CACHE_REPORT_DIR: reportDir },
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("only a newly passing target");
    const env = { ...base, GITHUB_REPOSITORY: "xnmp/tauri-explorer", GH_TOKEN: "read-only", TEST_CACHE_DIR: cacheDir };
    const producer = { id: 9, event: "push", head_branch: "dev", head_repository: { full_name: env.GITHUB_REPOSITORY },
      path: ".github/workflows/ci.yml", head_sha: "same-input", run_attempt: 1, status: "completed", conclusion: "failure" };
    const fetchApi = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/workflows/ci.yml/runs")) return Response.json({ workflow_runs: [producer] });
      if (path.endsWith("/artifacts")) return Response.json({ artifacts: [
        { id: 99, name: `trusted-${cacheKeys(env, "unit").prefix}9-1`, expired: false },
      ] });
      if (path.endsWith("/zip")) return new Response(readFileSync(archive));
      throw new Error(`Unexpected API request: ${path}`);
    };
    expect(await cacheModule.restoreCache(env, "unit", fetchApi, fixture)).toBe(true);
    const unit = cache("ci:unit", "unit", { TEST_CACHE_WRITE: "false", FAIL: "3" });
    expect(unit.status).toBe(0);
    expect(unit.record).toMatchObject({ cached: true, passed: true });
    expect(await cacheModule.restoreCache(env, "chromium-1", fetchApi, fixture)).toBe(false);
    const browser = cache("ci:e2e", "chromium-1", { TEST_CACHE_WRITE: "false", FAIL: "3" });
    expect(browser.status).not.toBe(0);
    expect(browser.record).toMatchObject({ cached: false, passed: false });
    expect(runs()).toEqual(["ci:unit", "ci:e2e", "ci:e2e"]);
  }, 60_000);

  it.each(["runs", "attempts"])("searches independent archives across %s for the requested hash", async (kind) => {
    const older = mkdtempSync(join(scratch, "older-result-"));
    const newer = mkdtempSync(join(scratch, "newer-result-"));
    const first = cache("ci:unit", "unit", { TEST_CACHE_DIR: older });
    const zipA = publishedArchive(older, "unit", "older-result");
    const second = cache("ci:unit", "unit", { TEST_CACHE_DIR: newer, UNIT_SELECTION: "src/lib/a.ts" });
    const zipB = publishedArchive(newer, "unit", "newer-result");
    expect(second.record.hash).not.toBe(first.record.hash);
    const env = { ...base, GITHUB_REPOSITORY: "xnmp/tauri-explorer", GH_TOKEN: "read-only", TEST_CACHE_DIR: cacheDir };
    const producer = { id: 9, event: "push", head_branch: "dev", head_repository: { full_name: env.GITHUB_REPOSITORY },
      path: ".github/workflows/ci.yml", head_sha: "same-input", run_attempt: kind === "attempts" ? 2 : 1,
      status: "completed", conclusion: "success" };
    const downloads: number[] = [];
    const fetchApi = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/workflows/ci.yml/runs")) return Response.json({ workflow_runs:
        kind === "attempts" ? [producer] : [producer, { ...producer, id: 8 }] });
      if (path.endsWith("/attempts/1")) return Response.json({ ...producer, run_attempt: 1 });
      if (path.endsWith("/artifacts")) {
        const prefix = cacheKeys(env, "unit").prefix;
        return Response.json({ artifacts: kind === "attempts" ? [
          { id: 99, name: `trusted-${prefix}9-2`, expired: false },
          { id: 98, name: `trusted-${prefix}9-1`, expired: false },
        ] : [{ id: path.includes("/runs/9/") ? 99 : 98,
          name: `trusted-${prefix}${path.includes("/runs/9/") ? 9 : 8}-1`, expired: false }] });
      }
      const artifact = Number(path.match(/artifacts\/(\d+)\/zip$/)?.[1]);
      if (artifact) { downloads.push(artifact); return new Response(readFileSync(artifact === 99 ? zipB : zipA)); }
      throw new Error(`Unexpected API request: ${path}`);
    };
    expect(await cacheModule.restoreCache(env, "unit", fetchApi, fixture)).toBe(true);
    const result = cache("ci:unit", "unit", { TEST_CACHE_WRITE: "false", FAIL: "3" });
    expect(result.status).toBe(0);
    expect(result.record).toMatchObject({ cached: true, passed: true, hash: first.record.hash });
    expect(runs()).toEqual(["ci:unit", "ci:unit"]);
    expect(downloads).toEqual([99, 98]);
  }, 60_000);

  it.each([
    { passed: false }, { exitCode: 3 }, { target: "chromium-1" }, { task: "ci:e2e" },
    { cached: true }, { stored: false }, { hash: "../outside" },
  ])("does not replay an artifact without a valid target pass record: %o", async (override) => {
    const seed = mkdtempSync(join(scratch, "invalid-record-"));
    const first = cache("ci:unit", "unit", { TEST_CACHE_DIR: seed });
    const zip = publishedArchive(seed, "unit", "invalid-record");
    const archiveDir = join(scratch, "test-cache-archive/unit");
    writeFileSync(join(archiveDir, "result.json"), JSON.stringify({ ...first.record, ...override }));
    execFileSync("zip", ["-q", zip, "result.json"], { cwd: archiveDir });
    const env = { ...base, GITHUB_REPOSITORY: "xnmp/tauri-explorer", GH_TOKEN: "read-only", TEST_CACHE_DIR: cacheDir };
    const producer = { id: 9, event: "push", head_branch: "dev", head_repository: { full_name: env.GITHUB_REPOSITORY },
      path: ".github/workflows/ci.yml", head_sha: "same-input", run_attempt: 1, status: "completed", conclusion: "failure" };
    const fetchApi = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/workflows/ci.yml/runs")) return Response.json({ workflow_runs: [producer] });
      if (path.endsWith("/artifacts")) return Response.json({ artifacts: [
        { id: 99, name: `trusted-${cacheKeys(env, "unit").prefix}9-1`, expired: false },
      ] });
      if (path.endsWith("/zip")) return new Response(readFileSync(zip));
      throw new Error(`Unexpected API request: ${path}`);
    };
    expect(await cacheModule.restoreCache(env, "unit", fetchApi, fixture)).toBe(false);
    const result = cache("ci:unit", "unit", { TEST_CACHE_WRITE: "false", FAIL: "3" });
    expect(result.status).not.toBe(0);
    expect(result.record).toMatchObject({ cached: false, passed: false });
    expect(runs()).toEqual(["ci:unit", "ci:unit"]);
  }, 60_000);

  it.each([
    ["ci:rust", "rust-default", { RUST_SUITE: "default" }],
    ["ci:rust", "rust-opt-in", { RUST_SUITE: "opt-in", RUST_TEST_FEATURES: "avif,durable-recovery,e2e-hooks" }],
    ["ci:e2e", "chromium-1", {}],
    ["ci:e2e", "webkit-1", { E2E_ENGINE: "webkit", WEBKIT: "1", PW_VIDEO_HEADED: "1" }],
  ])("restores the producing environment for %s / %s", async (task, target, selection) => {
    const seed = mkdtempSync(join(scratch, "target-environment-"));
    const first = cache(task, target, { ...selection, TEST_CACHE_DIR: seed });
    const zip = publishedArchive(seed, target, "target-environment");
    const env = { ...base, ...selection, GITHUB_REPOSITORY: "xnmp/tauri-explorer", GH_TOKEN: "read-only", TEST_CACHE_DIR: cacheDir };
    const producer = { id: 9, event: "push", head_branch: "dev", head_repository: { full_name: env.GITHUB_REPOSITORY },
      path: ".github/workflows/ci.yml", head_sha: "same-input", run_attempt: 1, status: "completed", conclusion: "failure" };
    const fetchApi = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/workflows/ci.yml/runs")) return Response.json({ workflow_runs: [producer] });
      if (path.endsWith("/artifacts")) return Response.json({ artifacts: [
        { id: 99, name: `trusted-${cacheKeys(env, target).prefix}9-1`, expired: false },
      ] });
      if (path.endsWith("/zip")) return new Response(readFileSync(zip));
      throw new Error(`Unexpected API request: ${path}`);
    };
    expect(await cacheModule.restoreCache(env, target, fetchApi, fixture)).toBe(true);
    const result = cache(task, target, { ...selection, TEST_CACHE_WRITE: "false", FAIL: "3" });
    expect(result.status).toBe(0);
    expect(result.record).toMatchObject({ cached: true, passed: true, hash: first.record.hash });
    expect(runs()).toEqual([task]);
  }, 60_000);

  it("explains a target's hash with the files and env vars it covers", () => {
    const stored = cache("ci:rust", "rust-default");
    const result = spawnSync(process.execPath, [SCRIPT, "explain", "--task", "ci:rust"], {
      cwd: fixture, encoding: "utf8", env: { ...base, TEST_CACHE_DIR: cacheDir },
    });
    const explained = JSON.parse(result.stdout);
    expect(explained.hash).toBe(stored.record.hash);
    expect(explained.toolchain).toContain("rustc 1.90.0");
    expect(Object.keys(explained.files)).toEqual(expect.arrayContaining(["src-tauri/src/lib.rs", "scripts/ci-test-rust.sh"]));
    expect(Object.keys(explained.files)).not.toContain("src/lib/a.ts");
    expect(explained.env.configured.join(" ")).toContain("RUST_SUITE=");
  }, 60_000);

  it("re-runs every target when the cache read is bypassed", () => {
    cache("ci:unit", "unit");
    expect(probe("ci:unit", "unit", { TEST_CACHE_READ: "false" })).toContain("hit=false");
    const bypass = cache("ci:unit", "unit", { TEST_CACHE_READ: "false" });
    expect(bypass.record).toMatchObject({ cached: false, passed: true });
    expect(runs()).toHaveLength(2);
  }, 60_000);

  it("ignores cache entries planted in the checkout", () => {
    const seed = mkdtempSync(join(scratch, "seed-"));
    cache("ci:unit", "unit", { TEST_CACHE_DIR: seed });
    expect(readdirSync(seed).length).toBeGreaterThan(0);
    // A PR can commit files anywhere in the tree, including Turborepo's default
    // cache locations; they must never satisfy a run.
    for (const rel of [".turbo/cache", "node_modules/.cache/turbo"]) cpSync(seed, join(fixture, rel), { recursive: true });
    const run = cache("ci:unit", "unit");
    expect(run.record).toMatchObject({ cached: false, passed: true });
    expect(runs()).toHaveLength(2);
    expect(cache("ci:unit", "unit", { TEST_CACHE_DIR: join(fixture, ".turbo/cache") }).status).not.toBe(0);
  }, 60_000);
});

describe("turbo.json", () => {
  it("hashes the platform, runner image and toolchain into every target", () => {
    expect(turbo.globalEnv).toEqual(expect.arrayContaining(["RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion", "TEST_CACHE_TOOLCHAIN"]));
    for (const task of ["ci:unit", "ci:rust", "ci:e2e"]) {
      // $TURBO_DEFAULT$ hashes git-tracked files only; explicit include globs
      // would also hash ignored build output such as src-tauri/target.
      expect(turbo.tasks[task].inputs[0]).toBe("$TURBO_DEFAULT$");
      expect(turbo.tasks[task].inputs.slice(1).every((g: string) => g.startsWith("!"))).toBe(true);
      expect(turbo.tasks[task].outputs).toEqual([]);
      expect(turbo.tasks[task]).not.toHaveProperty("cache");
    }
    expect(turbo).not.toHaveProperty("remoteCache");
    expect(turbo).not.toHaveProperty("cacheDir");
  });

  // An exclusion is safe only while nothing the target runs reads the excluded
  // files. Ask the real Turborepo which repository files each target hashes,
  // then scan the target's readers for repository paths in string literals.
  // Paths resolve from the reading file and from the target's working
  // directory; bare file names resolve from the working directory only where
  // the target reads root files by name (the unit tests read README.md).
  const readers: Record<string, { dirs: string[]; files: string[]; cwd: string; bareFromCwd: boolean }> = {
    "ci:unit": { dirs: ["tests", "scripts"], files: ["vitest.config.ts", "vitest.perf.config.ts"], cwd: "", bareFromCwd: true },
    "ci:rust": {
      dirs: ["src-tauri/src", "src-tauri/tests", "src-tauri/test_support", "src-tauri/benches"],
      files: ["src-tauri/build.rs"], cwd: "src-tauri", bareFromCwd: true,
    },
    "ci:e2e": {
      dirs: ["e2e", "src"], files: ["playwright.config.ts", "vite.config.ts", "svelte.config.js", "scripts/e2e-shards.mjs"],
      cwd: "", bareFromCwd: false,
    },
  };
  // Files every target's result depends on beyond its readers' literals.
  const required: Record<string, string[]> = {
    "ci:unit": ["package.json", "bun.lock", "website/package.json", "website/bun.lock", "tsconfig.json", "vitest.config.ts",
      "vitest.perf.config.ts", "svelte.config.js", "vite.config.ts", "scripts/ci-test-unit.sh"],
    "ci:rust": ["package.json", "bun.lock", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/.cargo/audit.toml",
      "src-tauri/build.rs", "src-tauri/tauri.conf.json", "src-tauri/tauri.linux.conf.json", "scripts/ci-test-rust.sh"],
    "ci:e2e": ["package.json", "bun.lock", "tsconfig.json", "playwright.config.ts", "vite.config.ts", "svelte.config.js",
      "scripts/ci-test-e2e.sh", "scripts/e2e-shards.mjs", "scripts/e2e-shard-timings.json", "scripts/prepare-pdf-assets.mjs"],
  };
  // Strings that name files without reading them: a selector fixture, and
  // this file's scratch-repository paths.
  const notReads: Record<string, string[] | "all"> = {
    "tests/rust-affected.test.ts": ["CLAUDE.md"],
    "tests/test-cache.test.ts": "all",
  };
  const hashed = (task: string) => {
    const dry = spawnSync(TURBO, [
      "run", task, "--dry=json", "--env-mode=loose", "--dangerously-disable-package-manager-check",
      `--cache-dir=${join(tmpdir(), "test-cache-guard")}`,
    ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" }, maxBuffer: 256 * 1024 * 1024 });
    const summary = JSON.parse(dry.stdout);
    return new Set([...Object.keys(summary.tasks[0].inputs), ...Object.keys(summary.globalCacheInputs.files)]);
  };
  const walk = (rel: string): string[] => readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((e) => {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "target" ? [] : walk(child);
    return /\.(ts|js|mjs|svelte|rs)$/.test(e.name) ? [child] : [];
  });
  const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n"));

  it.each(Object.keys(readers))("hashes every file %s reads", (task) => {
    const inputs = hashed(task);
    expect(required[task].filter((f) => !inputs.has(f))).toEqual([]);
    const { dirs, files } = readers[task];
    const violations = new Set<string>();
    for (const file of [...dirs.flatMap(walk), ...files]) {
      if (notReads[file] === "all") continue;
      // Comments name files without reading them.
      const content = readFileSync(join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of content.matchAll(/["'`]([^"'`\s]*\/[^"'`\s]*|[\w.-]+\.[A-Za-z0-9]+)["'`]/g)) {
        const literal = match[1].split(/[?#]/)[0];
        if (notReads[file]?.includes(literal)) continue;
        // Screenshot destinations and path-prefix tests are not reads.
        const before = content.slice(Math.max(0, (match.index ?? 0) - 120), match.index);
        if (/screenshot\(\s*\{[^}]*$/.test(before) || /startsWith\(\s*$/.test(before)) continue;
        // Browser specs save acceptance and issue screenshots into evidence/
        // and screenshots/ through capture helpers; they never read them back.
        if (task === "ci:e2e" && /^(evidence|screenshots)\//.test(literal)) continue;
        const { cwd, bareFromCwd } = readers[task];
        const bases = literal.includes("/") || bareFromCwd ? [dirname(file), cwd] : [dirname(file)];
        for (const from of bases) {
          const rel = relative(ROOT, resolve(ROOT, from, literal));
          if (rel.startsWith("..") || !existsSync(join(ROOT, rel))) continue;
          const isDir = statSync(join(ROOT, rel)).isDirectory();
          const read = isDir ? [...tracked].filter((f) => f.startsWith(`${rel}/`)) : tracked.has(rel) ? [rel] : [];
          if (read.length > 0 && !read.some((f) => inputs.has(f))) violations.add(`${file} reads ${rel}`);
        }
      }
    }
    expect([...violations]).toEqual([]);
  }, 60_000);
});

describe("ci.yml cache wiring", () => {
  type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  const steps = (job: string) => ci.jobs[job].steps as Step[];
  const targets: Record<string, string> = {
    "frontend-checks": "unit",
    chromium: "chromium-${{ matrix.shard }}",
    "chromium-view-modes": "chromium-view-modes-${{ matrix.shard }}",
    "webkit-tests": "webkit-${{ matrix.shard }}",
    "rust-suite": "rust-${{ matrix.suite }}",
  };

  /**
   * Evaluate a workflow-level `${{ }}` expression. These use only ==, !=, &&,
   * ||, ! and quoted strings, which mean the same in JavaScript once equality
   * is strict and a missing property reads as undefined (GitHub's null).
   */
  const evaluate = (expression: string, context: { github: object; inputs?: object; vars?: object }) => {
    const body = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "").replace(/==/g, "===").replace(/!=(?!=)/g, "!==");
    const js = body.replace(/\b(github|inputs|vars)((?:\.[\w-]+)+)/g, (_m, root: string, path: string) =>
      `${root}${path.split(".").slice(1).map((k) => `?.[${JSON.stringify(k)}]`).join("")}`);
    return String(new Function("github", "inputs", "vars", `return (${js});`)(context.github, context.inputs ?? {}, context.vars ?? {}));
  };
  const pr = (fullName: string) => ({
    event_name: "pull_request", ref: "refs/pull/7/merge", repository: "xnmp/tauri-explorer",
    event: { pull_request: { head: { repo: { full_name: fullName } } } },
  });
  const events = {
    "dev push": { event_name: "push", ref: "refs/heads/dev", repository: "xnmp/tauri-explorer", event: {} },
    "main push": { event_name: "push", ref: "refs/heads/main", repository: "xnmp/tauri-explorer", event: {} },
    "same-repo PR": pr("xnmp/tauri-explorer"),
    "fork PR": pr("someone/tauri-explorer"),
    "manual run": { event_name: "workflow_dispatch", ref: "refs/heads/dev", repository: "xnmp/tauri-explorer", event: {} },
  };

  it.each([
    ["dev push", "true"], ["same-repo PR", "false"], ["main push", "false"], ["fork PR", "false"], ["manual run", "false"],
  ] as const)("lets a %s write: %s", (event, writes) => {
    expect(ci.env.TEST_CACHE_WRITE).toBe(`\${{ ${TRUSTED_WRITE} }}`);
    expect(evaluate(ci.env.TEST_CACHE_WRITE, { github: events[event] })).toBe(writes);
  });

  it("reads unless a manual run unticks test_cache or the repository turns it off", () => {
    expect(ci.on.workflow_dispatch.inputs.test_cache).toMatchObject({ type: "boolean", default: true });
    const read = (github: object, inputs: object = {}, vars: object = {}) => evaluate(ci.env.TEST_CACHE_READ, { github, inputs, vars });
    for (const event of Object.values(events)) expect(read(event, event.event_name === "workflow_dispatch" ? { test_cache: true } : {})).toBe("true");
    expect(read(events["manual run"], { test_cache: false })).toBe("false");
    // The nightly run executes every target (#1367).
    expect(read({ ...events["dev push"], event_name: "schedule" })).toBe("false");
    expect(read(events["dev push"], {}, { TEST_CACHE: "off" })).toBe("false");
    expect(read(events["fork PR"], {}, { TEST_CACHE: "off" })).toBe("false");
  });

  // Browser jobs install nothing per shard: they run in the Playwright image
  // (#1367, tests/ci-playwright-container.test.ts).
  it.each([
    ["rust-suite", "Install Tauri Linux system dependencies"],
    ["rust-suite", "Swatinem/rust-cache@v2"],
  ])("%s skips '%s' only on a probed cache hit", (job, name) => {
    const all = steps(job);
    const probe = all.findIndex((s) => s.id === "test-cache-probe");
    const setup = all.findIndex((s) => (s.name ?? s.uses) === name);
    expect(probe).toBeGreaterThan(all.findIndex((s) => s.name === "Restore test-result cache"));
    expect(setup).toBeGreaterThan(probe);
    expect(all[setup].if).toMatch(/(^|&& )steps\.test-cache-probe\.outputs\.hit != 'true'$/);
    expect(all[probe].run).toMatch(/^node scripts\/test-cache\.mjs probe --task ci:(e2e|rust) --target "/);
  });

  it.each(Object.entries(targets))("%s restores by platform prefix and saves only trusted new results", (job, target) => {
    const all = steps(job);
    const key = all.find((s) => s.id === "test-cache-key");
    expect(key?.run).toBe(`node scripts/test-cache.mjs key --target "${target}"`);
    const restore = all.find((s) => s.name === "Restore test-result cache");
    expect(restore?.run).toBe(`node scripts/test-cache.mjs restore --target "${target}"`);
    expect(restore?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    const run = all.find((s) => s.id === "test-cache-run");
    expect(run?.run).toContain(`node scripts/test-cache.mjs run --task ci:`);
    expect(run?.run).toContain(`--target "${target}"`);
    const save = all.find((s) => s.name === "Save test-result cache");
    expect(save?.if).toBe("success() && env.TEST_CACHE_WRITE == 'true' && steps.test-cache-run.outputs.stored == 'true'");
    expect(save?.uses).toBe("actions/upload-artifact@v7");
    expect(save?.with).toEqual({
      path: "${{ steps.test-cache-pack.outputs.archive }}", name: "trusted-${{ steps.test-cache-key.outputs.key }}",
      "retention-days": 30, "if-no-files-found": "error",
    });
    const pack = all.find((s) => s.id === "test-cache-pack");
    expect(pack?.run).toBe(`node scripts/test-cache.mjs pack --target "${target}"`);
    expect(pack?.if).toBe(save?.if);
    // No shared cache namespace may satisfy a test-result check.
    expect(all.filter((s) => s.uses?.startsWith("actions/cache"))).toEqual([]);
    expect(all.indexOf(restore as Step)).toBeLessThan(all.indexOf(run as Step));
    expect(all.indexOf(run as Step)).toBeLessThan(all.indexOf(save as Step));
    const upload = all.find((s) => s.uses?.startsWith("actions/upload-artifact@") && String(s.with?.name).startsWith("test-cache-"));
    expect(upload?.with).toMatchObject({ name: `test-cache-${target}`, "if-no-files-found": "ignore" });
    // Container jobs read the record path from the container's RUNNER_TEMP.
    expect(upload?.if).toMatch(/^always\(\)( && env\.TEST_CACHE_REPORT != '')?$/);
  });

  it("hashes the same unit selection during restore and execution", () => {
    const job = ci.jobs["frontend-checks"];
    const restore = steps("frontend-checks").find((s) => s.name === "Restore test-result cache");
    const run = steps("frontend-checks").find((s) => s.id === "test-cache-run");
    const effective = (step: Step | undefined) => ({ ...ci.env, ...job.env, ...step?.env });
    expect(effective(restore).UNIT_SELECTION).toBe("${{ needs.changes.outputs.unit }}");
    expect(effective(run).UNIT_SELECTION).toBe(effective(restore).UNIT_SELECTION);
  });

  it("summarises the hit rate across every cached target", () => {
    const report = ci.jobs["test-cache"];
    expect(report.if).toBe("always()");
    expect(report.needs).toEqual(expect.arrayContaining(Object.keys(targets)));
    expect(JSON.stringify(report.steps)).toContain("node scripts/test-cache.mjs report");
  });
});
