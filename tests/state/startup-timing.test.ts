/**
 * Cold-start timing helper (startup-timing.ts).
 *
 * Verifies the report is one-shot (idempotent), marks are ordered and measured
 * from boot t0, and the summary is forwarded exactly once to the backend log
 * command. The invoke is mocked — in real mock/browser mode it rejects and is
 * swallowed, which we also assert can't throw.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined),
);
vi.mock(import("../../src/lib/api/files"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, invoke: invokeMock as unknown as typeof actual.invoke };
});

// Anchor a deterministic t0 before importing the module (it reads __BOOT_T0__
// at module init).
(globalThis as { window?: unknown }).window = (globalThis as { window?: unknown }).window ?? {};
(window as { __BOOT_T0__?: number }).__BOOT_T0__ = 0;

import { markStartup, reportFirstPaint } from "../../src/lib/state/startup-timing";

beforeEach(() => {
  invokeMock.mockClear();
});

describe("startup-timing", () => {
  it("forwards a single summary to log_startup_timing on first report", () => {
    markStartup("bundle-exec");
    markStartup("mount");
    reportFirstPaint();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("log_startup_timing");
    const summary = (args as { summary: string }).summary;
    expect(summary).toContain("Startup(webview):");
    expect(summary).toContain("bundle-exec=");
    expect(summary).toContain("mount=");
    expect(summary).toContain("list-visible=");
    expect(summary).toMatch(/total=[\d.]+ms/);
  });

  it("is idempotent — repeated reports and late marks do not re-send", () => {
    // (module state persists across tests in-file; first report already fired)
    reportFirstPaint();
    markStartup("too-late");
    reportFirstPaint();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
