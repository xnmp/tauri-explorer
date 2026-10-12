import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { installExternalJobFixture } from "../../e2e-tauri/external-job-fixture";
import { createNativeProcessCleanupHooks } from "../../e2e-tauri/native-qualification";

it.skipIf(process.platform !== "linux")("admits a cold interpreter before the fixture deadline and reaps its owned process group", async () => {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  const cleanup = createNativeProcessCleanupHooks({
    environment, stateEnvironmentKey: "TAURI_NATIVE_CLEANUP_STATE_DIRECTORY", stop: async () => {},
  });
  cleanup.prepare();
  const root = environment.TAURI_NATIVE_CLEANUP_STATE_DIRECTORY!;
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"]).toString().trim();
  const wrapper = path.join(root, "python3");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nsleep 0.3\nexec ${quote(python)} "$@"\n`, { mode: 0o755 });
  environment.PATH = `${root}:${environment.PATH}`;
  installExternalJobFixture(environment);
  const child = spawn("gemini", [], { cwd: root, env: environment, detached: true, stdio: "ignore" });
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const deadline = setTimeout(kill, Number(environment.TAURI_EXPLORER_E2E_PLUGIN_JOB_TIMEOUT_MS));
  try {
    await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    expect(fs.existsSync(environment.TAURI_E2E_EXTERNAL_JOB_PID!)).toBe(true);
    expect(fs.existsSync(path.join(root, "nanobanana-output", "late.png"))).toBe(false);
  } finally {
    clearTimeout(deadline); kill(); await cleanup.complete();
  }
}, 10_000);
