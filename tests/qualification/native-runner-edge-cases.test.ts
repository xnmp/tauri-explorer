import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNativeQualificationReport,
  executeLoggedQualificationProcess,
  measureProcessTreeRss,
  parseMacStartupLog,
  resolveQualificationArtifactPath,
  resolveSoakArtifactPaths,
  resolveSoakConfiguration,
  stopNativeQualificationProcesses,
  stopNativeStartupProcess,
  waitForMacStartupProcess,
  type NativeStartupChild,
} from "../../e2e-tauri/native-qualification";

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
    expect(
      parseMacStartupLog(
        "Startup: setup=800µs total=1.204s\n" +
          "Startup(warm-activate): show=950µs\n",
      ),
    ).toEqual({ coldTotalMs: 1_204, warmShowMs: 0.95 });
    expect(
      parseMacStartupLog(
        "Startup: setup=10ms total=750000ns\n" +
          "Startup(warm-activate): show=1.5ms\n",
      ),
    ).toEqual({ coldTotalMs: 0.75, warmShowMs: 1.5 });
  });

  it("rejects signal termination during the full startup survival window", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    let log =
      "Startup: setup=10ms total=20ms\n" + "Startup(warm-activate): show=2ms\n";
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

  it("captures early child output and persists it in the failed report", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-driver-log-"));
    const logPath = path.join(dir, "seed-webdriver.log");
    const reportPath = path.join(dir, "report.json");
    const result = await executeLoggedQualificationProcess({
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('driver stdout proof\\n');" +
          "process.stderr.write('driver stderr proof\\n');" +
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
      "process.stdout.write('scenario report emitted\\n');" +
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
      runErrors: ["qualification process exited with code 23"],
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
