import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

// Tauri's Linux system packages come from the hosted runners' apt mirror,
// which has stalled for 17–35 minutes (#1371). The shared action bounds each
// apt attempt and reuses cached .debs, so a stalled mirror fails in a setup
// step (eligible for ci-auto-rerun) instead of at the job timeout.
const SCRIPT = new URL("../.github/actions/tauri-linux-deps/apt.sh", import.meta.url).pathname;
const ACTION = "./.github/actions/tauri-linux-deps";
const WORKFLOWS = ["ci", "e2e-tauri", "image-crop", "native-recovery", "release", "shared-ai-services"];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs apt.sh with sudo/apt-get/dpkg replaced by stubs. The apt-get stub logs
 * its arguments and, for `install`, sleeps on the attempts listed in HANG.
 */
function run(command: string, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ci-apt-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "apt.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("sudo", 'exec "$@"');
  stub("dpkg", `echo "dpkg $*" >> ${log}`);
  stub(
    "apt-get",
    `echo "apt-get $*" >> ${log}
case " $* " in
  *" -s install "*) printf '%s\\n' "\${SIM_PLAN:-Inst libfoo (1.0 Ubuntu:24.04 [amd64])}" ;;
  *" install "*)
    n=$(grep -c ' install ' ${log} || true)
    case " \${HANG:-} " in *" $n "*) sleep 30 ;; esac
    if [ -n "\${APT_ARCHIVES_STUB:-}" ]; then touch "$APT_ARCHIVES_STUB/libfoo_1.0_amd64.deb"; fi ;;
esac`,
  );
  const archives = join(root, "archives");
  const result = spawnSync("bash", [SCRIPT, command], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      APT_PACKAGES: "libfoo nasm",
      APT_ARCHIVES: archives,
      APT_ARCHIVES_STUB: archives,
      APT_ATTEMPT_TIMEOUT: "1",
      APT_UPDATE_ATTEMPT_TIMEOUT: "1",
      ...env,
    },
  });
  const calls = (() => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  })();
  return { ...result, calls, archives };
}

describe("apt.sh install", () => {
  it("installs into the cache directory and keeps the downloaded .debs", () => {
    const { status, calls, archives, stdout } = run("install");
    expect(status).toBe(0);
    const install = calls.find((c) => / install /.test(c));
    expect(install).toContain(`Dir::Cache::archives=${archives}`);
    expect(install).toContain("APT::Keep-Downloaded-Packages=true");
    expect(install).toMatch(/libfoo nasm$/);
    expect(readdirSync(archives)).toEqual(["libfoo_1.0_amd64.deb"]);
    expect(stdout).toContain("apt cache: 0 .debs restored, 1 after install");
  });

  it("retries a stalled attempt and recovers dpkg before the next one", () => {
    const { status, calls, stdout } = run("install", { HANG: "1" });
    expect(status).toBe(0);
    expect(calls.filter((c) => / install /.test(c) && !/ -s /.test(c))).toHaveLength(2);
    expect(calls).toContain("dpkg --configure -a");
    expect(stdout).toContain("::warning title=apt install attempt 1/3::apt install timed out after 1s");
  });

  it("fails the step after its bounded attempts instead of waiting on the mirror", () => {
    const started = Date.now();
    const { status, stdout } = run("install", { HANG: "1 2", APT_ATTEMPTS: "2" });
    expect(status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(stdout).toContain("::error title=apt install failed::apt install failed 2 attempts of 1s");
  });

  it("refuses to run without a package list", () => {
    const { status, calls } = run("install", { APT_PACKAGES: "" });
    expect(status).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe("apt.sh key", () => {
  const key = (env: Record<string, string> = {}) => {
    const { status, stdout } = run("key", { ImageOS: "ubuntu24", ...env });
    expect(status).toBe(0);
    return Object.fromEntries(stdout.trim().split("\n").map((line) => line.split("=", 2) as [string, string]));
  };

  it("names the cache by image and package set, regardless of order and spacing", () => {
    const a = key({ APT_PACKAGES: "nasm libfoo" });
    const b = key({ APT_PACKAGES: "  libfoo\n nasm " });
    expect(a).toEqual(b);
    expect(a.key.startsWith(a["restore-prefix"])).toBe(true);
    expect(a["restore-prefix"]).toMatch(/^tauri-apt-v1-ubuntu24-[0-9a-f]{16}-$/);
    expect(key({ APT_PACKAGES: "nasm" })["restore-prefix"]).not.toBe(a["restore-prefix"]);
    expect(key({ ImageOS: "ubuntu22" })["restore-prefix"]).not.toBe(a["restore-prefix"]);
  });

  it("revises the key when the install plan changes, keeping the restore prefix", () => {
    const before = key();
    const after = key({ SIM_PLAN: "Inst libfoo (1.1 Ubuntu:24.04 [amd64])" });
    expect(after.key).not.toBe(before.key);
    expect(after["restore-prefix"]).toBe(before["restore-prefix"]);
    // Nothing left to install still yields a key.
    expect(key({ SIM_PLAN: "" }).key).toMatch(/^tauri-apt-v1-/);
  });
});

describe("workflows", () => {
  type Step = { name?: string; uses?: string; run?: string; "timeout-minutes"?: number; with?: Record<string, string> };
  const steps = (workflow: string) => {
    const doc = parse(readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), "utf8"));
    return Object.values(doc.jobs as Record<string, { steps?: Step[] }>).flatMap((job) => job.steps ?? []);
  };

  it.each(WORKFLOWS)("%s installs apt packages only through the bounded action", (workflow) => {
    const all = steps(workflow);
    expect(all.filter((s) => /apt-get (install|update)/.test(s.run ?? ""))).toEqual([]);
    const installs = all.filter((s) => s.uses === ACTION);
    expect(installs.length).toBeGreaterThan(0);
    for (const step of installs) {
      expect(step.with?.packages).toBeTruthy();
      // The step bound is the backstop for the per-attempt bound.
      expect(step["timeout-minutes"]).toBeGreaterThan(0);
      // Named as an install so ci-auto-rerun treats a failure as setup.
      expect(step.name).toMatch(/\binstall\b/i);
    }
  });

  it("bounds rust-suite's separate index refresh", () => {
    const refresh = steps("ci").find((s) => s.name === "Refresh apt package index");
    expect(refresh?.run).toBe(".github/actions/tauri-linux-deps/apt.sh update");
    expect(refresh?.["timeout-minutes"]).toBeGreaterThan(0);
  });
});
