import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_command: string, _args?: unknown) => undefined);
vi.mock("$lib/api/common", () => ({ invoke }));

function dispatch(window: EventTarget, type: string, fields: Record<string, unknown>): void {
  window.dispatchEvent(Object.assign(new Event(type), fields));
}

async function installedWindow(): Promise<EventTarget> {
  const window = new EventTarget();
  vi.stubGlobal("window", window);
  vi.resetModules();
  const { installGlobalErrorHandlers } = await import("$lib/api/crash");
  installGlobalErrorHandlers();
  return window;
}

const commands = () => invoke.mock.calls.map(([command]) => command);

describe("global webview error handlers", () => {
  beforeEach(() => invoke.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it("logs an unhandled rejection without recording a crash report", async () => {
    const window = await installedWindow();

    dispatch(window, "unhandledrejection", { reason: new TypeError("rejected") });

    expect(commands()).toContain("log_frontend_error");
    expect(commands()).not.toContain("record_frontend_crash");
  });

  it("still records an uncaught error as a crash report", async () => {
    const window = await installedWindow();

    dispatch(window, "error", { message: "boom", filename: "app.js", error: new Error("boom") });

    expect(commands()).toContain("record_frontend_crash");
  });
});
