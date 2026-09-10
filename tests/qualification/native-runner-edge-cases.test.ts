import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNativeQualificationReport,
  createNativeProcessCleanupHooks,
  executeLoggedQualificationProcess,
  measureProcessTreeRss,
  parseAttributedMacStartupLog,
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

  it("propagates worker cleanup failures through native run completion", async () => {
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
    const markerDirectory = environment.NATIVE_CLEANUP_TEST_STATE;
    expect(markerDirectory).toBeTruthy();
    await expect(hooks.cleanup()).rejects.toThrow(
      "WebDriver remained alive after SIGKILL",
    );
    expect(fs.readdirSync(markerDirectory!)).toHaveLength(1);
    expect(() => hooks.complete()).toThrow(
      "native qualification cleanup failed: WebDriver remained alive after SIGKILL",
    );
    expect(fs.existsSync(markerDirectory!)).toBe(false);
    expect(environment.NATIVE_CLEANUP_TEST_STATE).toBeUndefined();
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
  });

  // Write fixture bytes synchronously before exiting, so these tests verify
  // parent log capture rather than child stdout buffering at process shutdown.
  it("captures early child output and persists it in the failed report", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-driver-log-"));
    const logPath = path.join(dir, "seed-webdriver.log");
    const reportPath = path.join(dir, "report.json");
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
      failureArtifacts: [logPath],
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
