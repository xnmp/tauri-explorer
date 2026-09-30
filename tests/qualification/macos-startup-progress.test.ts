/** Streamed startup progress (#936): diagnostic only, never readiness evidence. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeStartupProgress,
  MacStartupTimeoutError,
  parseAttributedMacStartupLog,
  summarizeStartupProgress,
  waitForMacStartupProcess,
  type NativeStartupChild,
} from "../../e2e-tauri/native-qualification";

const foreground = {
  firstFunctionalFrame: "not-observed",
  firstFunctionalFrameMs: null,
  inputOutcome: "not-verified",
  inputReadyMs: null,
  measureWarm: false,
} as const;

const NATIVE_WINDOW =
  "Startup(native-window): window=main app-run-epoch-ms=1000.0 process-entry-to-run=20.0ms window-built=100.0ms";
const WEBVIEW =
  "Startup(webview): window=main boot-epoch-ms=1300.0 bundle-exec=50.0ms mount=80.0ms commands-ready=100.0ms settings-ready=300.0ms list-ready=350.0ms app-ready=400.0ms ui-ready=450.0ms total=450.0ms";
const NATIVE_READY =
  "Startup(native-ready): window=main app-run-to-ready=810.0ms receipt-epoch-ms=1800.0";
const progress = (mark: string, webviewMs: number, appRunMs: number, window = "main") =>
  `[INFO][tauri_explorer_lib::system] Startup(webview-progress): window=${window} mark=${mark} webview-ms=${webviewMs.toFixed(1)} app-run-ms=${appRunMs.toFixed(1)}`;

/** The anatomy of every #936 stall: the listing completes, then silence. */
const stalledLog = [
  "[INFO][tauri_explorer_lib] Startup: pre-builder=26.458µs builder→setup=197.985084ms setup→window-built=487.743458ms total=685.755ms",
  "[INFO][tauri_explorer_lib] Startup(native-window): window=main app-run-epoch-ms=1790614159828.550 process-entry-to-run=0.3ms window-built=685.8ms",
  progress("bundle-exec", 325, 2300),
  progress("mount", 463, 2440),
  progress("commands-ready", 486, 2462),
  progress("heartbeat", 1000, 2980),
  progress("settings-ready", 1500, 3480),
  '[INFO][tauri_explorer_lib::files::dir_listing] navigation list_directory_fresh requested: path="/Users/runner/work/tauri-explorer/tauri-explorer"',
  '[INFO][tauri_explorer_lib::files::dir_listing] navigation list_directory_fresh completed: path="/Users/runner/work/tauri-explorer/tauri-explorer", entries=54, elapsed=1.896875ms',
  progress("bundle-exec", 200, 2600, "explorer-warm-measure"),
  progress("heartbeat", 2000, 3980),
  progress("heartbeat", 3000, 4980),
  progress("heartbeat", 4000, 5980),
].join("\n");

class FakeStartupChild extends EventEmitter implements NativeStartupChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startup progress lines", () => {
  it("never change what the attributed readiness parser measures", () => {
    const plain = [NATIVE_WINDOW, WEBVIEW, NATIVE_READY].join("\n");
    // Progress lines named after every attributed marker, interleaved before
    // and after the summary: a duplicate-marker or format leak would move time.
    const interleaved = [
      progress("bundle-exec", 50, 400),
      NATIVE_WINDOW,
      progress("list-ready", 350, 700),
      WEBVIEW,
      progress("ui-ready", 999, 999),
      NATIVE_READY,
      progress("app-ready", 1, 1),
    ].join("\n");
    expect(parseAttributedMacStartupLog(interleaved, foreground)).toEqual(
      parseAttributedMacStartupLog(plain, foreground),
    );
  });

  it("cannot satisfy readiness on their own", () => {
    const progressOnly = [
      NATIVE_WINDOW,
      ...["bundle-exec", "mount", "commands-ready", "settings-ready", "list-ready", "app-ready", "ui-ready"].map(
        (mark, index) => progress(mark, 50 * (index + 1), 400 + index),
      ),
      NATIVE_READY,
    ].join("\n");
    expect(() => parseAttributedMacStartupLog(progressOnly, foreground)).toThrow(
      "boot-epoch-ms marker missing",
    );
  });

  it("report the main window's last mark and whether the page kept running", () => {
    const summary = summarizeStartupProgress(stalledLog);
    expect(summary.lastMark).toEqual({ mark: "settings-ready", webviewMs: 1500, appRunMs: 3480 });
    expect(summary.marks.map(({ mark }) => mark)).toEqual([
      "bundle-exec",
      "mount",
      "commands-ready",
      "settings-ready",
    ]);
    // The warm window's lines belong to a different page.
    expect(summary.heartbeatsAfterLastMark).toBe(3);
    expect(summary.lastHeartbeat).toEqual({ mark: "heartbeat", webviewMs: 4000, appRunMs: 5980 });
    expect(describeStartupProgress(summary)).toBe(
      "main progress: last mark settings-ready at webview 1500.0ms (app-run 3480.0ms), " +
        "3 heartbeat(s) after it, last heartbeat at webview 4000.0ms (app-run 5980.0ms)",
    );
  });

  it("say so when a page reported nothing at all", () => {
    const summary = summarizeStartupProgress(NATIVE_WINDOW);
    expect(summary.lastMark).toBeNull();
    expect(describeStartupProgress(summary)).toBe("main progress: no marks reported, 0 heartbeat(s)");
  });

  it("ignore malformed or truncated progress lines", () => {
    const summary = summarizeStartupProgress(
      [
        "Startup(webview-progress): window=main mark=Bad webview-ms=1.0 app-run-ms=1.0",
        "Startup(webview-progress): window=main mark=list-ready webview-ms=",
        progress("mount", 80, 500),
      ].join("\n"),
    );
    expect(summary.marks).toEqual([{ mark: "mount", webviewMs: 80, appRunMs: 500 }]);
  });
});

describe("startup timeout", () => {
  it("names the last parser rejection and the last streamed mark", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    const result = waitForMacStartupProcess(child, () => stalledLog, {
      timeoutMs: 1_000,
      survivalMs: 5_000,
      pollMs: 25,
      measureWarm: false,
    });
    const assertion = expect(result).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof MacStartupTimeoutError)) return false;
      expect(error.message).toBe(
        "startup markers missing after 1000ms; " +
          "last parser rejection: boot-epoch-ms marker missing from macOS process log; " +
          "main progress: last mark settings-ready at webview 1500.0ms (app-run 3480.0ms), " +
          "3 heartbeat(s) after it, last heartbeat at webview 4000.0ms (app-run 5980.0ms)",
      );
      expect(error.lastRejection).toBe("boot-epoch-ms marker missing from macOS process log");
      expect(error.progress.lastMark?.mark).toBe("settings-ready");
      return true;
    });
    await vi.advanceTimersByTimeAsync(1_050);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces a clock-correlation rejection that used to read as missing markers", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    const disagreeing = [NATIVE_WINDOW, WEBVIEW, NATIVE_READY.replace("1800.0", "601800.0")].join("\n");
    const result = waitForMacStartupProcess(child, () => disagreeing, {
      timeoutMs: 100,
      survivalMs: 5_000,
      measureWarm: false,
    });
    const assertion = expect(result).rejects.toThrow(
      /^startup markers missing after 100ms; last parser rejection: correlated startup clocks disagree/,
    );
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });
});
