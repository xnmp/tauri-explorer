/** Core Explorer readiness reporting: accurate boot origin and one-shot logging. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
vi.mock("$lib/api/environment", () => ({ logStartupTiming: log }));

beforeEach(() => {
  vi.resetModules();
  log.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", { __BOOT_T0__: 0 });
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
      "Startup(webview): bundle-exec=10.0ms list-ready=20.0ms ui-ready=40.0ms total=40.0ms",
    );

    markStartup("too-late");
    reportStartupReady();
    expect(log).toHaveBeenCalledOnce();
  });

  it("contains telemetry failures without blocking readiness reporting", async () => {
    log.mockRejectedValue(new Error("logging unavailable"));
    const { reportStartupReady } = await import("$lib/state/startup-timing");
    expect(() => reportStartupReady()).not.toThrow();
    await Promise.resolve();
    expect(log).toHaveBeenCalledOnce();
  });
});
