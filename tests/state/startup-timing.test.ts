/** Core Explorer readiness reporting: accurate boot origin and one-shot logging. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
const progress = vi.hoisted(() => vi.fn());
const nativeWindow = vi.hoisted(() => ({ label: "main" }));
vi.mock("$lib/api/environment", () => ({ logStartupTiming: log, logStartupProgress: progress }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => nativeWindow }));

beforeEach(() => {
  vi.resetModules();
  log.mockReset().mockResolvedValue(undefined);
  progress.mockReset().mockResolvedValue(undefined);
  nativeWindow.label = "main";
  vi.stubGlobal("window", { __BOOT_T0__: 0, __BOOT_EPOCH_MS__: 1_700_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A native window: the label comes from Tauri, not the browser fallback. */
function stubNativeWindow(): void {
  vi.stubGlobal("window", {
    __BOOT_T0__: 0,
    __BOOT_EPOCH_MS__: 1_700_000_000_000,
    __TAURI_INTERNALS__: {},
  });
}

describe("startup timing", () => {
  it("retains a zero boot origin and reports distinct listing and ready milestones", async () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { markStartup, reportStartupReady } = await import("$lib/state/startup-timing");
    markStartup("bundle-exec");
    now = 20;
    markStartup("list-ready");
    now = 40;
    reportStartupReady();
    expect(log).toHaveBeenCalledWith(
      "Startup(webview): window=browser boot-epoch-ms=1700000000000.000 " +
        "bundle-exec=10.0ms list-ready=20.0ms ui-ready=40.0ms total=40.0ms",
    );

    markStartup("too-late");
    reportStartupReady();
    expect(log).toHaveBeenCalledOnce();
  });

  it("falls back to the performance time origin when app.html seeded no boot epoch", async () => {
    vi.stubGlobal("window", { __BOOT_T0__: 0 });
    vi.spyOn(performance, "now").mockImplementation(() => 5);
    const { reportStartupReady } = await import("$lib/state/startup-timing");
    reportStartupReady();
    const summary = log.mock.calls[0][0] as string;
    // The epoch anchor must still be a real wall-clock millisecond value so the
    // native qualification report can correlate it with the Rust process clock.
    const epoch = Number(/boot-epoch-ms=([\d.]+)/.exec(summary)?.[1]);
    expect(epoch).toBeCloseTo(performance.timeOrigin, 0);
  });

  it("contains telemetry failures without blocking readiness reporting", async () => {
    log.mockRejectedValue(new Error("logging unavailable"));
    const { reportStartupReady } = await import("$lib/state/startup-timing");
    expect(() => reportStartupReady()).not.toThrow();
    await Promise.resolve();
    expect(log).toHaveBeenCalledOnce();
  });

  it("never streams progress from a browser page", async () => {
    vi.spyOn(performance, "now").mockImplementation(() => 1);
    const { markStartup, reportStartupReady } = await import("$lib/state/startup-timing");
    markStartup("bundle-exec");
    reportStartupReady();
    expect(progress).not.toHaveBeenCalled();
  });
});

describe("startup progress stream (#936)", () => {
  it("mirrors each main-window mark as it is recorded, before the summary exists", async () => {
    stubNativeWindow();
    let now = 12;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { markStartup } = await import("$lib/state/startup-timing");
    markStartup("bundle-exec");
    now = 30;
    markStartup("settings-ready");
    // A stalled startup never writes the summary, yet its progress is logged.
    expect(log).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual([
      ["bundle-exec", 12],
      ["settings-ready", 30],
    ]);
  });

  it("beats while startup is pending and stops once ready", async () => {
    stubNativeWindow();
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { markStartup, reportStartupReady, STARTUP_HEARTBEAT_INTERVAL_MS } =
      await import("$lib/state/startup-timing");
    markStartup("bundle-exec");
    now = 1_000;
    await vi.advanceTimersByTimeAsync(STARTUP_HEARTBEAT_INTERVAL_MS);
    now = 2_000;
    await vi.advanceTimersByTimeAsync(STARTUP_HEARTBEAT_INTERVAL_MS);
    expect(progress.mock.calls.filter(([mark]) => mark === "heartbeat")).toEqual([
      ["heartbeat", 1_000],
      ["heartbeat", 2_000],
    ]);

    reportStartupReady();
    expect(progress).toHaveBeenLastCalledWith("ui-ready", 2_000);
    const calls = progress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STARTUP_HEARTBEAT_INTERVAL_MS * 5);
    expect(progress).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the heartbeat of a startup that never becomes ready", async () => {
    stubNativeWindow();
    vi.useFakeTimers();
    const { markStartup, STARTUP_HEARTBEAT_INTERVAL_MS, STARTUP_HEARTBEAT_LIMIT } =
      await import("$lib/state/startup-timing");
    markStartup("bundle-exec");
    await vi.advanceTimersByTimeAsync(STARTUP_HEARTBEAT_INTERVAL_MS * (STARTUP_HEARTBEAT_LIMIT + 10));
    expect(progress.mock.calls.filter(([mark]) => mark === "heartbeat")).toHaveLength(
      STARTUP_HEARTBEAT_LIMIT,
    );
    expect(vi.getTimerCount()).toBe(0);
    // A later mark still streams, but the exhausted heartbeat does not restart.
    markStartup("settings-ready");
    expect(progress).toHaveBeenLastCalledWith("settings-ready", expect.any(Number));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("streams nothing from other native windows", async () => {
    stubNativeWindow();
    nativeWindow.label = "explorer-warm-measure";
    vi.useFakeTimers();
    const { markStartup } = await import("$lib/state/startup-timing");
    markStartup("bundle-exec");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(progress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains progress telemetry failures", async () => {
    stubNativeWindow();
    progress.mockRejectedValue(new Error("ipc unavailable"));
    const { markStartup, reportStartupReady } = await import("$lib/state/startup-timing");
    expect(() => markStartup("bundle-exec")).not.toThrow();
    expect(() => reportStartupReady()).not.toThrow();
    await Promise.resolve();
    expect(log).toHaveBeenCalledOnce();
  });
});
