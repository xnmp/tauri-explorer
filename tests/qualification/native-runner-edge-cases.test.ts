import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNativeQualificationReport,
  createNativeProcessCleanupHooks,
  createNativeFixtureDirectory,
  executeLoggedQualificationProcess,
  measureProcessTreeRss,
  parseAttributedMacStartupLog,
  resetSoakWorkerLogDirectory,
  resolveQualificationArtifactPath,
  resolveSoakArtifactPaths,
  resolveSoakConfiguration,
  stopNativeQualificationProcesses,
  stopNativeStartupProcess,
  waitForMacStartupProcess,
  type NativeStartupChild,
} from "../../e2e-tauri/native-qualification";

/**
 * Exactly the lines the binary emits (see the captured Linux proxy sample).
 * The readiness predicate and the report share one parser deliberately: an
 * independent "is it ready" regex drifted from this format once (#696).
 */
const NATIVE_WINDOW =
  "Startup(native-window): window=main app-run-epoch-ms=1000.0 process-entry-to-run=20.0ms window-built=100.0ms";
const WEBVIEW =
  "Startup(webview): window=main boot-epoch-ms=1300.0 bundle-exec=50.0ms mount=80.0ms commands-ready=100.0ms settings-ready=300.0ms list-ready=350.0ms app-ready=400.0ms ui-ready=450.0ms total=450.0ms";
const NATIVE_READY =
  "Startup(native-ready): window=main app-run-to-ready=810.0ms receipt-epoch-ms=1800.0";
const READY_LOG = `${NATIVE_WINDOW}\n${WEBVIEW}\n${NATIVE_READY}\n`;
const WARM = "Startup(warm-activate): show=4.0ms";

class FakeStartupChild extends EventEmitter implements NativeStartupChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  onKill?: (signal: NodeJS.Signals | undefined) => boolean;

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return this.onKill?.(signal) ?? true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("native qualification process boundaries", () => {
  it("normalizes the duration units emitted by Rust startup markers", () => {
    const scaled = READY_LOG.replace("app-run-to-ready=810.0ms", "app-run-to-ready=0.81s")
      .replace("process-entry-to-run=20.0ms", "process-entry-to-run=20000us")
      .replace("window-built=100.0ms", "window-built=100000000ns");
    expect(
      parseAttributedMacStartupLog(`${scaled}Startup(warm-activate): show=950µs\n`),
    ).toMatchObject({
      coldTotalMs: 810,
      warmShowMs: 0.95,
      phases: { processEntryMs: 20, nativeWindowMs: 100 },
    });
  });

  it("rejects signal termination during the full startup survival window", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    let log = `${READY_LOG}${WARM}\n`;
    const result = waitForMacStartupProcess(child, () => log, {
      timeoutMs: 1_000,
      survivalMs: 5_000,
      pollMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    child.exit(null, "SIGTERM");

    await expect(result).rejects.toThrow("SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
    log = "";
  });

  it("qualifies foreground-only launch without requiring a probe window", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    const result = waitForMacStartupProcess(child, () => READY_LOG, {
      timeoutMs: 100,
      survivalMs: 200,
      measureWarm: false,
    });
    const assertion = expect(result).resolves.toMatchObject({
      coldTotalMs: 810,
      warmShowMs: null,
      // The readiness predicate is the attributed parser, so a resolved wait
      // already carries the phases the report publishes.
      phases: { requiredAppWorkMs: 350, unattributedMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("still requires foreground readiness and process survival without warm measurement", async () => {
    expect(() =>
      parseAttributedMacStartupLog("Startup: total=12ms\n", {
        firstFunctionalFrame: "not-observed",
        firstFunctionalFrameMs: null,
        inputOutcome: "not-verified",
        inputReadyMs: null,
        measureWarm: false,
      }),
    ).toThrow("native-window");
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    const result = waitForMacStartupProcess(child, () =>
      "Startup(native-ready): app-run-to-ready=125ms\n", {
      timeoutMs: 100,
      survivalMs: 200,
      measureWarm: false,
    });
    child.exit(1, null);
    await expect(result).rejects.toThrow("application exited");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports spawn errors and clears timeout polling", async () => {
    vi.useFakeTimers();
    const spawnFailure = new FakeStartupChild();
    const failed = waitForMacStartupProcess(spawnFailure, () => "", {
      timeoutMs: 1_000,
      survivalMs: 5_000,
      pollMs: 25,
    });
    spawnFailure.emit("error", new Error("spawn ENOENT"));
    await expect(failed).rejects.toThrow("spawn ENOENT");
    expect(vi.getTimerCount()).toBe(0);

    const timedOut = new FakeStartupChild();
    const timeout = waitForMacStartupProcess(timedOut, () => "", {
      timeoutMs: 100,
      survivalMs: 5_000,
      pollMs: 25,
    });
    const timeoutAssertion = expect(timeout).rejects.toThrow(
      "startup markers missing after 100ms",
    );
    await vi.advanceTimersByTimeAsync(150);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(timedOut.listenerCount("exit")).toBe(0);
    expect(timedOut.listenerCount("error")).toBe(0);
  });

  it("fails cleanup when a force-killed process remains alive", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    const stopped = stopNativeStartupProcess(child, {
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 50,
    });
    const assertion = expect(stopped).rejects.toThrow(
      "remained alive after SIGKILL",
    );

    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    expect(child.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirms forced exit and rejects a refused force kill", async () => {
    vi.useFakeTimers();
    const exited = new FakeStartupChild();
    exited.onKill = (signal) => {
      if (signal === "SIGKILL") exited.exit(null, signal);
      return true;
    };
    const stopped = stopNativeStartupProcess(exited, {
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopped).resolves.toBeUndefined();
    expect(exited.killSignals).toEqual([undefined, "SIGKILL"]);

    const rejected = new FakeStartupChild();
    rejected.onKill = (signal) => signal !== "SIGKILL";
    const failed = stopNativeStartupProcess(rejected, {
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 50,
    });
    const failureAssertion = expect(failed).rejects.toThrow(
      "SIGKILL was rejected",
    );
    await vi.advanceTimersByTimeAsync(150);
    await failureAssertion;
    expect(rejected.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reaps every owned native process after graceful or forced exit", async () => {
    vi.useFakeTimers();
    const driver = new FakeStartupChild();
    driver.onKill = (signal) => {
      if (signal === undefined) driver.exit(null, "SIGTERM");
      return true;
    };
    const application = new FakeStartupChild();
    application.onKill = (signal) => {
      if (signal === "SIGKILL") application.exit(null, signal);
      return true;
    };

    const stopped = stopNativeQualificationProcesses(
      [
        { label: "WebDriver", child: driver },
        { label: "application", child: application },
      ],
      { gracefulTimeoutMs: 100, forceTimeoutMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(stopped).resolves.toBeUndefined();
    expect(driver.killSignals).toEqual([undefined]);
    expect(application.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails native cleanup after attempting to reap every owned process", async () => {
    vi.useFakeTimers();
    const stuckDriver = new FakeStartupChild();
    const application = new FakeStartupChild();
    application.onKill = (signal) => {
      if (signal === undefined) application.exit(null, "SIGTERM");
      return true;
    };

    const stopped = stopNativeQualificationProcesses(
      [
        { label: "WebDriver", child: stuckDriver },
        { label: "application", child: application },
      ],
      { gracefulTimeoutMs: 100, forceTimeoutMs: 50 },
    );
    const assertion = expect(stopped).rejects.toThrow(
      "WebDriver remained alive after SIGKILL",
    );
    await vi.advanceTimersByTimeAsync(150);

    await assertion;
    expect(stuckDriver.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(application.killSignals).toEqual([undefined]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps native fixtures until worker teardown and removes them at launcher completion", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const launcher = createNativeProcessCleanupHooks({
      environment,
      stateEnvironmentKey: "TAURI_NATIVE_CLEANUP_STATE_DIRECTORY",
      stop: async () => { throw new Error("launcher does not own worker processes"); },
    });
    launcher.prepare();
    const workerEnvironment = { ...environment };
    const root = environment.TAURI_NATIVE_CLEANUP_STATE_DIRECTORY!;
    const fixture = createNativeFixtureDirectory("window-chrome-", workerEnvironment);
    let stopped = false;
    const worker = createNativeProcessCleanupHooks({
      environment: workerEnvironment,
      stateEnvironmentKey: "TAURI_NATIVE_CLEANUP_STATE_DIRECTORY",
      stop: async () => {
        expect(fs.readFileSync(path.join(fixture, "retained.txt"), "utf8")).toBe("session-owned");
        stopped = true;
      },
    });
    try {
      fs.writeFileSync(path.join(fixture, "retained.txt"), "session-owned");
      expect(fs.existsSync(fixture)).toBe(true);
      expect(stopped).toBe(false);
      await worker.cleanup();
      expect(stopped).toBe(true);
      expect(fs.existsSync(fixture)).toBe(true);
      launcher.complete();
      expect(fs.existsSync(fixture)).toBe(false);
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains fixtures on both filesystems until one worker teardown completes", async () => {
    const environment: NodeJS.ProcessEnv = {};
    let stops = 0;
    const hooks = createNativeProcessCleanupHooks({
      environment,
      stateEnvironmentKey: "TAURI_NATIVE_CLEANUP_STATE_DIRECTORY",
      additionalFixtureRoots: [{ stateEnvironmentKey: "SECOND_FIXTURE_ROOT", temporaryRoot: os.tmpdir() }],
      stop: async () => {
        stops++;
        expect(fs.readFileSync(path.join(first, "proof"), "utf8")).toBe("first");
        expect(fs.readFileSync(path.join(second, "proof"), "utf8")).toBe("second");
      },
    });
    hooks.prepare();
    const first = environment.TAURI_NATIVE_CLEANUP_STATE_DIRECTORY!;
    const second = environment.SECOND_FIXTURE_ROOT!;
    try {
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      fs.writeFileSync(path.join(first, "proof"), "first");
      fs.writeFileSync(path.join(second, "proof"), "second");
      await hooks.cleanup();
      expect(stops).toBe(1);
      expect(fs.existsSync(first) && fs.existsSync(second)).toBe(true);
      hooks.complete();
      expect(fs.existsSync(first) || fs.existsSync(second)).toBe(false);
      expect(environment.SECOND_FIXTURE_ROOT).toBeUndefined();
    } finally {
      hooks.complete();
    }
  });

  it("rolls back prepared roots when another fixture volume cannot be prepared", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "native-prepare-rollback-"));
    const environment: NodeJS.ProcessEnv = {};
    const hooks = createNativeProcessCleanupHooks({
      environment, temporaryRoot: parent, stateEnvironmentKey: "PRIMARY",
      additionalFixtureRoots: [{ stateEnvironmentKey: "SECONDARY", temporaryRoot: path.join(parent, "missing") }],
      stop: async () => {},
    });
    try {
      expect(() => hooks.prepare()).toThrow();
      expect(fs.readdirSync(parent)).toEqual([]);
      expect(environment.PRIMARY).toBeUndefined();
      expect(environment.SECONDARY).toBeUndefined();
    } finally {
      hooks.complete();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("removes the second fixture volume even when primary removal fails", () => {
    const environment: NodeJS.ProcessEnv = {};
    const hooks = createNativeProcessCleanupHooks({
      environment, stateEnvironmentKey: "PRIMARY",
      additionalFixtureRoots: [{ stateEnvironmentKey: "SECONDARY", temporaryRoot: os.tmpdir() }],
      stop: async () => {},
    });
    hooks.prepare();
    const first = environment.PRIMARY!;
    const second = environment.SECONDARY!;
    const remove = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target === first) throw new Error("primary locked");
      return remove(target, options);
    });
    try {
      expect(second).toBeTruthy();
      expect(() => hooks.complete()).toThrow("primary locked");
      expect(fs.existsSync(second)).toBe(false);
      expect(environment.SECONDARY).toBeUndefined();
    } finally {
      spy.mockRestore();
      fs.rmSync(first, { recursive: true, force: true });
      if (second) fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("refuses unowned native fixtures and nested fixture prefixes", () => {
    expect(() => createNativeFixtureDirectory("fixture-", {})).toThrow("ownership is unavailable");
    expect(() => createNativeFixtureDirectory("../escape-", {
      TAURI_NATIVE_CLEANUP_STATE_DIRECTORY: os.tmpdir(),
    })).toThrow("invalid native fixture prefix");
  });

  it("propagates worker cleanup failures through native run completion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-cleanup-hook-"));
    const environment: NodeJS.ProcessEnv = {};
    const hooks = createNativeProcessCleanupHooks({
      environment,
      stateEnvironmentKey: "NATIVE_CLEANUP_TEST_STATE",
      temporaryRoot: dir,
      additionalFixtureRoots: [{ stateEnvironmentKey: "NATIVE_SECONDARY_TEST_STATE", temporaryRoot: dir }],
      stop: async () => {
        throw new Error("WebDriver remained alive after SIGKILL");
      },
    });

    hooks.prepare();
    const markerDirectory = environment.NATIVE_CLEANUP_TEST_STATE;
    const secondaryDirectory = environment.NATIVE_SECONDARY_TEST_STATE;
    expect(markerDirectory).toBeTruthy();
    expect(secondaryDirectory).toBeTruthy();
    await expect(hooks.cleanup()).rejects.toThrow(
      "WebDriver remained alive after SIGKILL",
    );
    expect(fs.readdirSync(markerDirectory!)).toHaveLength(1);
    expect(() => hooks.complete()).toThrow(
      "native qualification cleanup failed: WebDriver remained alive after SIGKILL",
    );
    expect(fs.existsSync(markerDirectory!)).toBe(true);
    expect(fs.existsSync(secondaryDirectory!)).toBe(true);
    expect(environment.NATIVE_CLEANUP_TEST_STATE).toBe(markerDirectory);
    expect(environment.NATIVE_SECONDARY_TEST_STATE).toBe(secondaryDirectory);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves both roots if a worker starts but afterSession never confirms process exit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-cleanup-hook-"));
    const environment: NodeJS.ProcessEnv = {};
    const hooks = createNativeProcessCleanupHooks({
      environment,
      stateEnvironmentKey: "NATIVE_CLEANUP_TEST_STATE",
      temporaryRoot: dir,
      additionalFixtureRoots: [{ stateEnvironmentKey: "NATIVE_SECONDARY_TEST_STATE", temporaryRoot: dir }],
      stop: async () => {},
    });
    hooks.prepare();
    const first = environment.NATIVE_CLEANUP_TEST_STATE!;
    const second = environment.NATIVE_SECONDARY_TEST_STATE!;
    hooks.begin();
    expect(() => hooks.complete()).toThrow("without confirming process exit");
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes owned roots only after a started worker confirms process exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-cleanup-hook-"));
    const environment: NodeJS.ProcessEnv = {};
    const hooks = createNativeProcessCleanupHooks({
      environment,
      stateEnvironmentKey: "NATIVE_CLEANUP_TEST_STATE",
      temporaryRoot: dir,
      stop: async () => {},
    });
    hooks.prepare();
    const root = environment.NATIVE_CLEANUP_TEST_STATE!;
    hooks.begin();
    expect(fs.readdirSync(root)).toHaveLength(1);
    await hooks.cleanup();
    expect(fs.readdirSync(root)).toEqual([]);
    hooks.complete();
    expect(fs.existsSync(root)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves fixture roots when cleanup markers cannot be read", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-cleanup-hook-"));
    const environment: NodeJS.ProcessEnv = {};
    const hooks = createNativeProcessCleanupHooks({
      environment,
      stateEnvironmentKey: "NATIVE_CLEANUP_TEST_STATE",
      temporaryRoot: dir,
      stop: async () => {
        throw new Error("WebDriver remained alive after SIGKILL");
      },
    });

    hooks.prepare();
    const markerDirectory = environment.NATIVE_CLEANUP_TEST_STATE!;
    await expect(hooks.cleanup()).rejects.toThrow(
      "WebDriver remained alive after SIGKILL",
    );
    expect(fs.readdirSync(markerDirectory)).toHaveLength(1);

    fs.writeFileSync(path.join(markerDirectory, "unreadable.json"), "{");
    expect(() => hooks.complete()).toThrow("failed to read cleanup markers");
    expect(fs.existsSync(markerDirectory)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps hostile replay seeds inside the qualification artifact root", () => {
    const root = path.resolve("qualification-results");
    const rawSeed = "  ../../outside/../release seed  ";
    const configuration = resolveSoakConfiguration({
      SOAK_SEED: rawSeed,
      SOAK_EXPECTED_DISPLAY_SCALE: "1",
    });
    const artifacts = resolveSoakArtifactPaths(root, "linux", rawSeed);

    expect(configuration.seed).toBe(rawSeed);
    expect(artifacts.seedComponent).not.toContain("/");
    expect(artifacts.seedComponent).not.toContain("..");
    for (const artifact of [
      artifacts.report,
      artifacts.driverLog,
      artifacts.failureDirectory,
      artifacts.workerLogDirectory,
    ]) {
      expect(path.relative(root, artifact)).not.toMatch(/^\.\.(?:[/\\]|$)/);
    }
    expect(() =>
      resolveQualificationArtifactPath(root, "../escaped.json"),
    ).toThrow("outside qualification root");

    const serialized = JSON.parse(
      JSON.stringify(
        buildNativeQualificationReport({
          build: {
            commit: "source",
            profile: "test",
            binary: "/qualified/tauri-explorer",
            binarySha256: "abc",
            binaryBytes: 42,
            binaryModifiedAt: "2026-09-09T00:00:00.000Z",
          },
          platform: {
            os: "linux",
            release: "test",
            arch: "x64",
            webview: "test",
            displayScale: 1,
          },
          configuration,
          startedAt: "2026-09-09T00:00:00.000Z",
          finishedAt: "2026-09-09T00:00:01.000Z",
          resources: [],
          scenarios: [],
        }),
      ),
    );
    expect(serialized.configuration.seed).toBe(rawSeed);
  });

  it("clears only this seed's old worker logs before a new qualification run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soak-worker-logs-"));
    try {
      const root = path.join(dir, "qualification-results");
      const worker = resolveSoakArtifactPaths(root, "linux", "repeat-seed")
        .workerLogDirectory;
      const otherSeed = path.join(root, "wdio-other-seed");
      fs.mkdirSync(worker, { recursive: true });
      fs.mkdirSync(otherSeed);
      fs.writeFileSync(path.join(worker, "stale.log"), "old run");
      fs.writeFileSync(path.join(otherSeed, "keep.log"), "other run");

      resetSoakWorkerLogDirectory(root, worker);
      expect(fs.readdirSync(worker)).toEqual([]);
      expect(fs.readFileSync(path.join(otherSeed, "keep.log"), "utf8"))
        .toBe("other run");

      const external = path.join(dir, "external");
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, "sentinel"), "untouched");
      fs.rmSync(worker, { recursive: true });
      fs.symlinkSync(external, worker, "dir");
      resetSoakWorkerLogDirectory(root, worker);
      expect(fs.lstatSync(worker).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(external, "sentinel"), "utf8"))
        .toBe("untouched");

      const rootLink = path.join(dir, "root-link");
      fs.symlinkSync(root, rootLink, "dir");
      expect(() => resetSoakWorkerLogDirectory(
        rootLink, path.join(rootLink, "wdio-repeat-seed"),
      )).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attributes RSS to the verified launched binary and its descendants", () => {
    const launchedBinary = path.resolve("/qualified/build/tauri-explorer");
    expect(
      measureProcessTreeRss(
        [
          {
            pid: 10,
            parentPid: 1,
            rssBytes: 100,
            executable: launchedBinary,
          },
          {
            pid: 11,
            parentPid: 10,
            rssBytes: 40,
            executable: "/usr/lib/webkit/WebKitWebProcess",
          },
          {
            pid: 99,
            parentPid: 1,
            rssBytes: 500,
            executable: path.resolve("src-tauri/target/debug/tauri-explorer"),
          },
        ],
        launchedBinary,
        123,
      ),
    ).toEqual({ rssBytes: 140, sampledAtMs: 123 });
    expect(() => measureProcessTreeRss([
      { pid: 10, parentPid: 1, rssBytes: 100, executable: launchedBinary },
      { pid: 20, parentPid: 1, rssBytes: 100, executable: launchedBinary },
    ], launchedBinary, 123)).toThrow("native process identity is ambiguous");
  });

  // Write fixture bytes synchronously before exiting, so these tests verify
  // parent log capture rather than child stdout buffering at process shutdown.
  it("captures early child output and persists it in the failed report", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-driver-log-"));
    const logPath = path.join(dir, "seed-webdriver.log");
    const reportPath = path.join(dir, "report.json");
    const workerLogDirectory = path.join(dir, "seed", "wdio");
    fs.mkdirSync(workerLogDirectory, { recursive: true });
    fs.writeFileSync(path.join(workerLogDirectory, "soak-0-0.log"), "worker proof\n");
    const result = await executeLoggedQualificationProcess({
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeSync(1, 'driver stdout proof\\n');" +
          "require('node:fs').writeSync(2, 'driver stderr proof\\n');" +
          "process.exit(23)",
      ],
      reportPath,
      driverLogPath: logPath,
      additionalFailureArtifacts: [workerLogDirectory, path.join(dir, "absent")],
      mirrorOutput: false,
      createFallbackReport: (exitCode) =>
        buildNativeQualificationReport({
          build: {
            commit: "source",
            profile: "debug-custom-protocol-e2e-hooks",
            binary: "/qualified/tauri-explorer",
            binarySha256: "abc",
            binaryBytes: 42,
            binaryModifiedAt: "2026-09-09T00:00:00.000Z",
          },
          platform: {
            os: "linux",
            release: "test",
            arch: "x64",
            webview: "unavailable",
            displayScale: null,
          },
          configuration: {
            durationMs: 1,
            maxCycles: 1,
            seed: "failure-seed",
            scenarios: [],
            expectedDisplayScale: 1,
          },
          startedAt: "2026-09-09T00:00:00.000Z",
          finishedAt: "2026-09-09T00:00:01.000Z",
          resources: [],
          scenarios: [],
          runErrors: [
            `WebDriver exited before a session started (code ${exitCode})`,
          ],
        }),
    });

    expect(result.exitCode).toBe(23);
    const persisted = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(persisted).toMatchObject({
      passed: false,
      failureArtifacts: [logPath, workerLogDirectory],
    });
    const driverLog = fs.readFileSync(logPath, "utf8");
    expect(driverLog).toContain("driver stdout proof");
    expect(driverLog).toContain("driver stderr proof");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails a passing report when its qualification child exits nonzero", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-driver-exit-"));
    const logPath = path.join(dir, "seed-webdriver.log");
    const reportPath = path.join(dir, "report.json");
    const scenario = {
      id: "window-workspace",
      iteration: 7,
      durationMs: 42,
      outcome: "passed",
      assertion: "visible explorer remained usable",
      failureArtifacts: [],
    };
    const passingReport = {
      passed: true,
      runErrors: [],
      failureArtifacts: [],
      scenarios: [scenario],
    };
    const childScript =
      `require('node:fs').writeFileSync(${JSON.stringify(reportPath)}, ` +
      `${JSON.stringify(JSON.stringify(passingReport))});` +
      "require('node:fs').writeSync(1, 'scenario report emitted\\n');" +
      "process.exit(23)";

    const result = await executeLoggedQualificationProcess({
      command: [process.execPath, "-e", childScript],
      reportPath,
      driverLogPath: logPath,
      mirrorOutput: false,
      createFallbackReport: () => ({
        passed: false,
        runErrors: ["report was not emitted"],
        failureArtifacts: [],
        scenarios: [],
      }),
    });

    expect(result.exitCode).toBe(23);
    expect(result.report).toMatchObject({
      passed: false,
      runErrors: ["qualification process exited with code 23 (signal none)"],
      failureArtifacts: [logPath],
      scenarios: [scenario],
    });
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toEqual(
      result.report,
    );
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "scenario report emitted",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
