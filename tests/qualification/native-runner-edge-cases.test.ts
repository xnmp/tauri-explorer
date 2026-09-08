import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addQualificationFailureArtifact,
  buildNativeQualificationReport,
  measureProcessTreeRss,
  parseMacStartupLog,
  stopNativeStartupProcess,
  waitForMacStartupProcess,
  writeQualificationArtifact,
  type NativeStartupChild,
} from "../../e2e-tauri/native-qualification";

class FakeStartupChild extends EventEmitter implements NativeStartupChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return true;
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
      "Startup: setup=10ms total=20ms\n" +
      "Startup(warm-activate): show=2ms\n";
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
    await vi.advanceTimersByTimeAsync(100);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(timedOut.listenerCount("exit")).toBe(0);
    expect(timedOut.listenerCount("error")).toBe(0);
  });

  it("escalates an unresponsive startup process to a force kill", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    const stopped = stopNativeStartupProcess(child, {
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(150);
    await stopped;
    expect(child.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
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
            executable: path.resolve(
              "src-tauri/target/debug/tauri-explorer",
            ),
          },
        ],
        launchedBinary,
        123,
      ),
    ).toEqual({ rssBytes: 140, sampledAtMs: 123 });
  });

  it("persists run-specific driver output as a failure artifact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-driver-log-"));
    const logPath = path.join(dir, "seed-webdriver.log");
    const reportPath = path.join(dir, "report.json");
    fs.writeFileSync(logPath, "WebKitWebDriver failed to start\n");
    const report = buildNativeQualificationReport({
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
      runErrors: ["WebDriver exited before a session started"],
    });

    writeQualificationArtifact(
      reportPath,
      addQualificationFailureArtifact(report, logPath),
    );
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toMatchObject({
      passed: false,
      failureArtifacts: [logPath],
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
