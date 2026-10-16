import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
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
      prefix: "test-cache-v1-Linux-X64-ubuntu24-20261012.1-unit-",
      key: "test-cache-v1-Linux-X64-ubuntu24-20261012.1-unit-7-2",
    });
    const variants = [
      { ...LINUX, RUNNER_OS: "Windows", ImageOS: "win25" },
      { ...LINUX, RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64", ImageOS: "macos15" },
      { ...LINUX, ImageVersion: "20261019.3" },
    ];
    for (const env of variants) {
      const other = cacheKeys(env, "unit");
      // restore-keys match by prefix: neither platform may restore the other's entries.
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
  it("drops whole entries unused for longer than the limit", () => {
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
  const TURBO = join(ROOT, "node_modules/.bin/turbo");
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
    for (const rel of [
      "src/lib/a.ts", "src-tauri/src/lib.rs", "src-tauri/Cargo.lock", "docs/guide.md", "README.md",
      "website/index.html", "e2e/a.spec.ts", "tests/a.test.ts", "evidence/1-proof.png",
    ]) write(rel, `// ${rel}\n`);
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

  it("re-runs the Rust target when the Rust toolchain or a system library changes", () => {
    cache("ci:rust", "rust-default");
    cache("ci:rust", "rust-default", { FAKE_RUSTC: "1.91.0" });
    cache("ci:rust", "rust-default", { FAKE_RUSTC: "1.91.0", FAKE_APT: "2.17.00" });
    cache("ci:rust", "rust-default", { FAKE_RUSTC: "1.91.0", FAKE_APT: "2.17.00", RUST_TEST_FEATURES: "avif" });
    expect(runs()).toEqual(["ci:rust", "ci:rust", "ci:rust", "ci:rust"]);
  }, 60_000);

  it.each([
    ["docs", "docs/guide.md", ["ci:unit"]],
    ["a README", "README.md", ["ci:unit"]],
    ["committed evidence", "evidence/1-proof.png", []],
    ["the website package", "website/index.html", ["ci:unit"]],
    ["the frontend package", "src/lib/a.ts", ["ci:unit", "ci:e2e"]],
    ["the Rust package", "src-tauri/src/lib.rs", ["ci:unit", "ci:rust"]],
    ["a unit test", "tests/a.test.ts", ["ci:unit"]],
    ["a browser spec", "e2e/a.spec.ts", ["ci:unit", "ci:e2e"]],
  ])("a change to %s re-runs only the targets that read it", (_label, file, rerun) => {
    const targets = [["ci:unit", "unit"], ["ci:rust", "rust-default"], ["ci:e2e", "chromium-1"]];
    for (const [task, target] of targets) cache(task, target);
    rmSync(runsLog);
    write(file, "changed\n");
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
      expect(turbo.tasks[task].inputs[0]).toBe("$TURBO_DEFAULT$");
      expect(turbo.tasks[task].outputs).toEqual([]);
      expect(turbo.tasks[task]).not.toHaveProperty("cache");
    }
    expect(turbo).not.toHaveProperty("remoteCache");
    expect(turbo).not.toHaveProperty("cacheDir");
  });

  // An exclusion is safe only while nothing the target runs reads the excluded
  // files. Scan each target's readers for repository paths in string literals.
  const readers: Record<string, { dirs: string[]; files: string[]; bases: string[] }> = {
    "ci:unit": { dirs: ["tests", "scripts"], files: ["vitest.config.ts", "vitest.perf.config.ts"], bases: [""] },
    "ci:rust": { dirs: ["src-tauri/src", "src-tauri/tests", "src-tauri/test_support", "src-tauri/benches"], files: ["src-tauri/build.rs"], bases: ["src-tauri"] },
    "ci:e2e": { dirs: ["e2e", "src"], files: ["playwright.config.ts", "vite.config.ts", "svelte.config.js", "scripts/e2e-shards.mjs"], bases: [""] },
  };
  const globToRegExp = (glob: string) => new RegExp(`^${glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?")}$`);
  const walk = (rel: string): string[] => readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((e) => {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "target" ? [] : walk(child);
    return /\.(ts|js|mjs|svelte|rs)$/.test(e.name) ? [child] : [];
  });

  it.each(Object.keys(readers))("excludes nothing that %s reads", (task) => {
    const excluded = (turbo.tasks[task].inputs as string[]).filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
    const { dirs, files, bases } = readers[task];
    const violations: string[] = [];
    for (const file of [...dirs.flatMap(walk), ...files]) {
      // Comments name files without reading them.
      const content = readFileSync(join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of content.matchAll(/["'`]([^"'`\s]*\/[^"'`\s]*)["'`]/g)) {
        const literal = match[1];
        // Screenshot destinations and path-prefix tests are not reads.
        const before = content.slice(Math.max(0, (match.index ?? 0) - 120), match.index);
        if (/screenshot\(\s*\{[^}]*$/.test(before) || /startsWith\(\s*$/.test(before)) continue;
        // Browser specs save acceptance screenshots into evidence/ through
        // capture helpers; it is their output directory, never read back.
        if (task === "ci:e2e" && /^evidence\/[^/]+\.png$/.test(literal)) continue;
        for (const from of [dirname(file), ...bases]) {
          const abs = resolve(ROOT, from, literal.split(/[?#]/)[0]);
          const rel = relative(ROOT, abs);
          if (rel.startsWith("..") || !existsSync(abs)) continue;
          const probes = statSync(abs).isDirectory() ? [`${rel}/x`] : [rel];
          if (probes.some((p) => excluded.some((re) => re.test(p)))) violations.push(`${file} reads ${rel}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("ci.yml cache wiring", () => {
  type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  const steps = (job: string) => ci.jobs[job].steps as Step[];
  const targets: Record<string, string> = {
    "frontend-checks": "unit",
    chromium: "chromium-${{ matrix.shard }}",
    "webkit-tests": "webkit-${{ matrix.shard }}",
    "rust-suite": "rust-${{ matrix.suite }}",
  };

  it("lets only dev pushes and same-repository pull requests write", () => {
    expect(ci.env.TEST_CACHE_WRITE).toBe(`\${{ ${TRUSTED_WRITE} }}`);
    expect(TRUSTED_WRITE).toBe(
      "(github.event_name == 'push' && github.ref == 'refs/heads/dev') || " +
      "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)",
    );
  });

  it("can bypass cache reads for a manual run or the whole repository", () => {
    expect(ci.on.workflow_dispatch.inputs.test_cache).toMatchObject({ type: "boolean", default: true });
    expect(ci.env.TEST_CACHE_READ).toBe(
      "${{ vars.TEST_CACHE != 'off' && !(github.event_name == 'workflow_dispatch' && !inputs.test_cache) }}",
    );
  });

  it.each(Object.entries(targets))("%s restores by platform prefix and saves only trusted new results", (job, target) => {
    const all = steps(job);
    const key = all.find((s) => s.id === "test-cache-key");
    expect(key?.run).toBe(`node scripts/test-cache.mjs key --target "${target}"`);
    const restore = all.find((s) => s.uses?.startsWith("actions/cache/restore@"));
    expect(restore?.with).toEqual({
      path: "${{ steps.test-cache-key.outputs.dir }}",
      key: "${{ steps.test-cache-key.outputs.key }}",
      "restore-keys": "${{ steps.test-cache-key.outputs.prefix }}",
    });
    const run = all.find((s) => s.id === "test-cache-run");
    expect(run?.run).toContain(`node scripts/test-cache.mjs run --task ci:`);
    expect(run?.run).toContain(`--target "${target}"`);
    const save = all.find((s) => s.uses?.startsWith("actions/cache/save@"));
    expect(save?.if).toBe("success() && env.TEST_CACHE_WRITE == 'true' && steps.test-cache-run.outputs.stored == 'true'");
    expect(save?.with).toEqual({ path: "${{ steps.test-cache-key.outputs.dir }}", key: "${{ steps.test-cache-key.outputs.key }}" });
    // actions/cache (restore + post-job save) would save from any run, forks included.
    expect(all.filter((s) => s.uses?.startsWith("actions/cache@") && JSON.stringify(s.with).includes("test-cache"))).toEqual([]);
    expect(all.indexOf(restore as Step)).toBeLessThan(all.indexOf(run as Step));
    expect(all.indexOf(run as Step)).toBeLessThan(all.indexOf(save as Step));
    const upload = all.find((s) => s.uses?.startsWith("actions/upload-artifact@") && String(s.with?.name).startsWith("test-cache-"));
    expect(upload?.with).toMatchObject({ name: `test-cache-${target}`, "if-no-files-found": "ignore" });
    expect(upload?.if).toBe("always()");
  });

  it("summarises the hit rate across every cached target", () => {
    const report = ci.jobs["test-cache"];
    expect(report.if).toBe("always()");
    expect(report.needs).toEqual(expect.arrayContaining(Object.keys(targets)));
    expect(JSON.stringify(report.steps)).toContain("node scripts/test-cache.mjs report");
  });
});
