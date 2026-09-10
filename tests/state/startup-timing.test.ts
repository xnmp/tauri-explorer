/** Core Explorer readiness reporting: accurate boot origin and one-shot logging. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
vi.mock("$lib/api/environment", () => ({ logStartupTiming: log }));

beforeEach(() => {
  vi.resetModules();
  log.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", { __BOOT_T0__: 0, __BOOT_EPOCH_MS__: 1_700_000_000_000 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
});
