import { afterEach, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: unknown }) => void) | undefined,
  acquire: undefined as ((stop: () => void) => void) | undefined,
  deferred: false,
  unlisten: vi.fn(),
  emitTo: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: harness.emitTo,
  listen: vi.fn(async (_event: string, listener: typeof harness.listener) => {
    harness.listener = listener;
    if (harness.deferred) return new Promise<() => void>((resolve) => { harness.acquire = resolve; });
    return harness.unlisten;
  }),
}));
import { requestWindowHandoff, acknowledgeWindowHandoff, type WindowHandoff } from "$lib/state/window-handoff";

beforeEach(() => { harness.deferred = false; harness.listener = undefined; harness.unlisten.mockReset(); harness.emitTo.mockClear(); });
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
