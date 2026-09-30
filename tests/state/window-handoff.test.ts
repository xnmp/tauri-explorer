import { afterEach, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: unknown }) => void) | undefined,
  acquire: undefined as ((stop: () => void) => void) | undefined,
  deferred: false,
  unlisten: vi.fn(),
  emitTo: vi.fn(async () => {}),
  log: vi.fn(),
}));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: harness.log }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: harness.emitTo,
  listen: vi.fn(async (_event: string, listener: typeof harness.listener) => {
    harness.listener = listener;
    if (harness.deferred) return new Promise<() => void>((resolve) => { harness.acquire = resolve; });
    return harness.unlisten;
  }),
}));
import { requestWindowHandoff, acknowledgeWindowHandoff, type WindowHandoff } from "$lib/state/window-handoff";

beforeEach(() => { harness.deferred = false; harness.listener = undefined; harness.unlisten.mockReset(); harness.emitTo.mockClear(); harness.log.mockClear(); });
afterEach(() => vi.useRealTimers());

it("keeps the source until the intended target acknowledges actual adoption", async () => {
  let request!: WindowHandoff;
  const dispatch = vi.fn(async (value: WindowHandoff) => { request = value; });
  let resolved = false;
  const result = requestWindowHandoff("source", "target", dispatch).then((value) => { resolved = true; return value; });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect(resolved).toBe(false);
  harness.listener!({ payload: { requestId: request.requestId, targetWindow: "wrong-window" } });
  await Promise.resolve();
  expect(resolved).toBe(false);
  harness.listener!({ payload: { requestId: request.requestId, targetWindow: "target" } });
  expect(await result).toBe(true);
  expect(harness.unlisten).toHaveBeenCalledOnce();
});

it("retains the source when delivery succeeds but no ready Explorer adopts it", async () => {
  vi.useFakeTimers();
  const dispatch = vi.fn(async () => {});
  const result = requestWindowHandoff("source", "picker", dispatch, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(await result).toBe(false);
  expect(harness.unlisten).toHaveBeenCalledOnce();
});

it("releases late listener acquisition after timeout without sending an abandoned transfer", async () => {
  vi.useFakeTimers();
  harness.deferred = true;
  const dispatch = vi.fn(async () => {});
  const result = requestWindowHandoff("source", "target", dispatch, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(false);
  harness.acquire!(harness.unlisten);
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.unlisten).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
});

it("retains the source and releases its listener when dispatch fails", async () => {
  expect(await requestWindowHandoff("source", "target", async () => { throw new Error("gone"); })).toBe(false);
  expect(harness.unlisten).toHaveBeenCalledOnce();
});

it("does not acknowledge malformed handoff metadata", async () => {
  await acknowledgeWindowHandoff({ sourceWindow: {}, requestId: "id" }, "target");
  expect(harness.emitTo).not.toHaveBeenCalled();
});

for (const asynchronous of [false, true]) {
  it(`settles accepted ownership when ${asynchronous ? "async" : "sync"} listener cleanup fails`, async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.unlisten.mockImplementation(() => {
      if (asynchronous) return Promise.reject(new Error("cleanup failed"));
      throw new Error("cleanup failed");
    });
    try {
      let request!: WindowHandoff;
      const result = requestWindowHandoff("source", "target", async (value) => { request = value; });
      await vi.waitFor(() => expect(request).toBeDefined());
      expect(() => harness.listener!({ payload: { requestId: request.requestId, targetWindow: "target" } })).not.toThrow();
      expect(await result).toBe(true);
      await vi.waitFor(() => expect(report).toHaveBeenCalled());
    } finally { report.mockRestore(); }
  });
}

it("settles rejected activation without waiting for its timeout", async () => {
  let request!: WindowHandoff;
  const result = requestWindowHandoff("source", "target", async (value) => { request = value; });
  await vi.waitFor(() => expect(request).toBeDefined());
  harness.listener!({ payload: { requestId: request.requestId, targetWindow: "target", accepted: false } });
  expect(await result).toBe(false);
  expect(harness.unlisten).toHaveBeenCalledOnce();
});

it("logs a timed-out handoff in every build, with its phase, elapsed time and windows", async () => {
  vi.useFakeTimers();
  const result = requestWindowHandoff("source", "target", async () => {}, 250);
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toBe(false);
  expect(harness.log).toHaveBeenCalledOnce();
  expect(harness.log).toHaveBeenCalledWith("window handoff failed", expect.objectContaining({
    phase: "timeout", adopted: false, elapsedMs: 250, sourceWindow: "source", targetWindow: "target", error: null,
  }));
});

it("logs a failed dispatch with a bounded error message", async () => {
  const failure = "x".repeat(1_000);
  expect(await requestWindowHandoff("source", "target", async () => { throw new Error(failure); })).toBe(false);
  expect(harness.log).toHaveBeenCalledWith("window handoff failed", expect.objectContaining({
    phase: "dispatch-error", error: `Error: ${failure}`.slice(0, 240),
  }));
});

/** Resolves to "pending" if `promise` has not settled within a short real-time bound. */
function settledWithin<T>(promise: Promise<T>, ms = 200): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);
}

it("settles a dispatch failure whose rejection value cannot be stringified", async () => {
  const unprintable = { toString() { throw new Error("toString exploded"); } };
  const result = requestWindowHandoff("source", "target", async () => { throw unprintable; }, 60_000);
  expect(await settledWithin(result)).toBe(false);
  expect(harness.unlisten).toHaveBeenCalledOnce();
  expect(harness.log).toHaveBeenCalledWith("window handoff failed", expect.objectContaining({
    phase: "dispatch-error", error: "(unprintable error)",
  }));
});

it("settles a failed handoff even when the log sink throws", async () => {
  harness.log.mockImplementationOnce(() => { throw new Error("log sink down"); });
  const result = requestWindowHandoff("source", "target", async () => { throw new Error("emit failed"); }, 60_000);
  expect(await settledWithin(result)).toBe(false);
  expect(harness.unlisten).toHaveBeenCalledOnce();
});

it("logs a target's explicit rejection", async () => {
  let request!: WindowHandoff;
  const result = requestWindowHandoff("source", "target", async (value) => { request = value; });
  await vi.waitFor(() => expect(request).toBeDefined());
  harness.listener!({ payload: { requestId: request.requestId, targetWindow: "target", accepted: false } });
  expect(await result).toBe(false);
  expect(harness.log).toHaveBeenCalledWith("window handoff failed", expect.objectContaining({
    phase: "acknowledgement", adopted: false, requestId: request.requestId,
  }));
});

it("does not log a successful handoff in builds without hooks", async () => {
  let request!: WindowHandoff;
  const result = requestWindowHandoff("source", "target", async (value) => { request = value; });
  await vi.waitFor(() => expect(request).toBeDefined());
  harness.listener!({ payload: { requestId: request.requestId, targetWindow: "target" } });
  expect(await result).toBe(true);
  expect(harness.log).not.toHaveBeenCalled();
});
