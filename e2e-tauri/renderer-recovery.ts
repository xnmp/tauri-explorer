/** Drive actual renderer death without a WebDriver session that dies with it. */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { exactApplicationPid, isolatedProcessEnvironment, processStartTime, terminateRendererDescendants } from "./native-process";

if (process.platform !== "linux") throw new Error("Native renderer recovery acceptance requires Linux");

const application = fs.realpathSync(path.resolve("src-tauri/target/debug/tauri-explorer"));
const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-renderer-recovery-"));
const fixture = path.join(runDirectory, "case");
const config = path.join(runDirectory, "config");
const runtime = path.join(runDirectory, "runtime");
fs.mkdirSync(fixture);
fs.mkdirSync(runtime, { mode: 0o700 });
fs.mkdirSync(path.join(config, "tauri-explorer"), { recursive: true });
fs.writeFileSync(path.join(config, "tauri-explorer/settings.json"), JSON.stringify({ warmWindow: false }));
fs.writeFileSync(path.join(fixture, "survivor.txt"), "same native window after renderer recovery");
for (let generation = 0; generation <= 2; generation++) {
  execFileSync("git", ["init", "--quiet", path.join(fixture, `repository-${generation}`)]);
}
const logPath = path.join(runDirectory, "application.log");
const log = fs.openSync(logPath, "w");
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  SHELL: "/bin/bash",
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: path.join(runDirectory, "data"),
  XDG_CACHE_HOME: path.join(runDirectory, "cache"),
  XDG_STATE_HOME: path.join(runDirectory, "state"),
  XDG_RUNTIME_DIR: runtime,
  TAURI_E2E_RECOVERY_DIR: fixture,
};
delete environment.WARM_MEASURE;
const child = spawn(application, [fixture], {
  cwd: fixture,
  env: environment,
  stdio: ["ignore", log, log],
});
fs.closeSync(log);
let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
let spawnError: Error | undefined;
const completion = new Promise<void>((resolve, reject) => {
  child.once("error", (error) => { spawnError = error; reject(error); });
  child.once("exit", (code, signal) => { exited = { code, signal }; resolve(); });
});
// A startup error is reported through the bounded runner loop as well as completion.
void completion.catch(() => {});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type State = {
  status: "armed" | "passed" | "failed";
  cycle?: number;
  processId: number;
  windowLabel: string;
  webviewAddress: string;
  error?: string;
  [key: string]: unknown;
};

type CycleEvidence = {
  cycle: number;
  oldSession: string;
  newSession: string;
  oldLeaseId: string;
  newLeaseId: string;
  repoRoot: string;
  marker: string;
  mutationStartedAt: number;
  watcherReceivedAt: number;
  watcherObservedAt: number;
  terminationReason: string;
  oldAcquireRejected: boolean;
  staleReleaseIgnored: boolean;
  oldLeaseReclaimed: boolean;
  entries: string[];
};

function verifyEvidence(state: State): void {
  assert.ok(Array.isArray(state.cycles), "Missing per-cycle recovery evidence");
  assert.equal(state.cycles.length, 2, "Two recovery cycles must complete");
  const cycles = state.cycles as CycleEvidence[];
  for (const [index, cycle] of cycles.entries()) {
    assert.equal(cycle.cycle, index + 1);
    for (const id of [cycle.oldSession, cycle.newSession, cycle.oldLeaseId, cycle.newLeaseId]) {
      assert.equal(typeof id, "string");
      assert.match(id, /^\d+$/);
    }
    assert.ok(BigInt(cycle.newSession) > BigInt(cycle.oldSession), "Renderer generation must advance");
    assert.notEqual(cycle.oldLeaseId, cycle.newLeaseId);
    if (index > 0) {
      assert.equal(cycle.oldSession, cycles[index - 1].newSession);
      assert.equal(cycle.oldLeaseId, cycles[index - 1].newLeaseId);
    }
    assert.equal(cycle.repoRoot, fs.realpathSync(path.join(fixture, `repository-${index + 1}`)));
    assert.equal(cycle.marker, `observed-after-crash-${index + 1}.txt`);
    assert.ok(fs.statSync(path.join(cycle.repoRoot, cycle.marker)).isFile());
    assert.ok(Number.isFinite(cycle.mutationStartedAt) && cycle.mutationStartedAt > 0);
    assert.ok(Number.isFinite(cycle.watcherObservedAt) && cycle.watcherObservedAt >= cycle.mutationStartedAt);
    assert.ok(Number.isFinite(cycle.watcherReceivedAt) && cycle.watcherReceivedAt >= cycle.watcherObservedAt);
    assert.equal(cycle.terminationReason, "Crashed");
    assert.equal(cycle.oldAcquireRejected, true);
    assert.equal(cycle.staleReleaseIgnored, true);
    assert.equal(cycle.oldLeaseReclaimed, true);
    assert.ok(Array.isArray(cycle.entries) && cycle.entries.every(entry => typeof entry === "string"));
    assert.ok(cycle.entries.includes(cycle.marker), "Recovered listing must show the observed mutation");
  }
}
function readState(): State | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(fixture, "state.json"), "utf8")) as State; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const armed = new Set<number>();
let nativeIdentity: Pick<State, "windowLabel" | "webviewAddress"> | undefined;
let applicationStart: string | null = null;
let succeeded = false;
try {
  const readinessDeadline = Date.now() + 30_000;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const state = readState();
    if (!state && Date.now() >= readinessDeadline) {
      throw new Error("Native harness did not arm; build with VITE_E2E_HOOKS=1 and --features e2e-renderer-recovery");
    }
    if (state) {
      if (state.processId !== child.pid) throw new Error("Recovery changed the native application PID");
      if (!state.windowLabel || !state.webviewAddress) throw new Error("Missing native window identity");
      nativeIdentity ??= { windowLabel: state.windowLabel, webviewAddress: state.webviewAddress };
      if (state.windowLabel !== nativeIdentity.windowLabel || state.webviewAddress !== nativeIdentity.webviewAddress) {
        throw new Error("Recovery replaced the native window or WebView");
      }
      if (state.status === "failed") throw new Error(state.error ?? "Native recovery scenario failed");
      if (state.status === "passed") {
        if (armed.size !== 2) throw new Error("Scenario passed without two externally killed renderers");
        verifyEvidence(state);
        await Promise.race([completion, pause(5_000)]);
        if (exited?.code !== 0) throw new Error(`Successful scenario did not exit cleanly: ${JSON.stringify(exited)}`);
        const screenshot = path.join(fixture, "recovered.png");
        if (!fs.existsSync(screenshot)) throw new Error("Recovery screenshot is missing");
        const destination = "screenshots/refactor/repo-health-cleanup/native-renderer-crash-recovery.png";
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(screenshot, destination);
        console.log(JSON.stringify({ ...state, runDirectory, screenshot: destination }, null, 2));
        succeeded = true;
        break;
      }
      if (state.status !== "armed") throw new Error(`Unknown recovery state: ${state.status}`);
      if (state.cycle !== 1 && state.cycle !== 2) throw new Error(`Invalid crash cycle: ${state.cycle}`);
      if (!armed.has(state.cycle)) {
        if (state.cycle !== armed.size + 1) throw new Error("Crash cycles arrived out of order");
        const pid = exactApplicationPid(config, application);
        if (pid !== child.pid) throw new Error("Exact test executable is not the spawned application");
        applicationStart ??= processStartTime(pid);
        if (!applicationStart || processStartTime(pid) !== applicationStart) throw new Error("Application PID was recycled");
        const renderers = terminateRendererDescendants(pid, isolatedProcessEnvironment(environment), {
          start: applicationStart, executable: application,
        });
        armed.add(state.cycle);
        console.log(`Killed renderer cycle ${state.cycle}: ${renderers.join(", ")}`);
      }
    }
    if (exited) {
      // Final state publication precedes exit, but may race the previous read.
      const final = readState();
      if (final?.status === "passed" || final?.status === "failed") continue;
      throw new Error(`App exited before a final recovery result: ${JSON.stringify(exited)}`);
    }
    await pause(100);
  }
  if (!succeeded) throw new Error("Native renderer recovery exceeded its 180-second deadline");
} catch (error) {
  console.error(`Recovery acceptance failed; native log: ${logPath}`);
  throw error;
} finally {
  if (!exited && child.pid) {
    child.kill("SIGTERM");
    await Promise.race([completion, pause(3_000)]).catch(() => {});
    if (!exited) child.kill("SIGKILL");
  }
}
