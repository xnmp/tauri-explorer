import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import { emptyHistorySummary } from "$lib/domain/file-history";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  receiveHistory: vi.fn(),
  session: vi.fn(async () => "session-1"),
  uuid: vi.fn(() => "request-1"),
}));

vi.mock("$lib/api/common", async (original) => ({
  ...await original<typeof import("$lib/api/common")>(),
  invoke: mocks.invoke,
  isTauri: () => false,
}));
vi.mock("$lib/api/native-resource-session", () => ({
  getNativeResourceSession: mocks.session,
  receiveHistorySummary: mocks.receiveHistory,
}));

import { copyEntries } from "$lib/api/copy-session";

const outcome: CopySessionOutcome = {
  items: [{ status: "skipped" }], cancelled: false, warnings: [],
};
const reply = () => ({ result: outcome, history: { ...emptyHistorySummary(), revision: 1 } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", { randomUUID: mocks.uuid });
});

describe("copyEntries", () => {
  it("checks large source collections without spreading them into the virtual-path guard", async () => {
    const sources = Array.from({ length: 200_000 }, () => "/src/a");
    sources[sources.length - 1] = "search://result";
    const result = await copyEntries(sources, "/dest", {
      signal: new AbortController().signal, jobId: 6, onConflict: vi.fn(),
    });
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not acquire a session or start effects when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await copyEntries(["/src/a"], "/dest", {
      signal: controller.signal, jobId: 7, onConflict: vi.fn(),
    });
    expect(result).toEqual({ ok: true, data: { items: [{ status: "unstarted" }], cancelled: true, warnings: [] } });
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("remembers cancellation before ready and sends it only after registration", async () => {
    const pending = deferred<ReturnType<typeof reply>>();
    let events!: (event: CopySessionEvent) => void;
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "copy_entries") { events = args.events as typeof events; return pending.promise; }
      if (command === "cancel_copy_session") return Promise.resolve();
      throw new Error(command);
    });
    const controller = new AbortController();
    const task = copyEntries(["/src/a"], "/dest", { signal: controller.signal, jobId: 8, onConflict: vi.fn() });
    await vi.waitFor(() => expect(events).toBeTypeOf("function"));
    controller.abort();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["copy_entries"]);
    events({ type: "ready" });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cancel_copy_session", {
      sessionId: "session-1", requestId: "request-1",
    }));
    pending.resolve(reply());
    await task;
  });

  it("resolves each exact conflict once, forwards events, and ignores late callbacks", async () => {
    let events!: (event: CopySessionEvent) => void;
    const pending = deferred<ReturnType<typeof reply>>();
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "copy_entries") { events = args.events as typeof events; return pending.promise; }
      return Promise.resolve();
    });
    const onEvent = vi.fn();
    const onConflict = vi.fn(async () => ({ choice: "skip" as const, applyToAll: false }));
    const task = copyEntries(["/src/a"], "/dest", {
      signal: new AbortController().signal, jobId: 9, shared: true, onConflict, onEvent,
    });
    await vi.waitFor(() => expect(events).toBeTypeOf("function"));
    events({ type: "ready" });
    const conflict = { fileName: "a", sourcePath: "/src/a", remaining: 0, sourceSize: 1,
      sourceModified: "now", destSize: 1, destModified: "now" };
    events({ type: "conflict", item: 0, nonce: "nonce-1", conflict });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("resolve_copy_conflict", {
      sessionId: "session-1", requestId: "request-1", item: 0, nonce: "nonce-1",
      decision: { choice: "skip", applyToAll: false },
    }));
    events({ type: "conflict", item: 0, nonce: "nonce-1", conflict });
    expect(onConflict).toHaveBeenCalledOnce();
    pending.resolve(reply());
    const result = await task;
    events({ type: "started", item: 0, total: 1 });
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    expect(mocks.receiveHistory).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
    expect(mocks.invoke).toHaveBeenCalledWith("copy_entries", expect.objectContaining({
      sessionId: "session-1",
      request: { requestId: "request-1", sources: ["/src/a"], destDir: "/dest", jobId: 9, shared: true },
    }));
  });

  it("aborts an outstanding prompt and surfaces conflict-resolution failure", async () => {
    let events!: (event: CopySessionEvent) => void;
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "copy_entries") { events = args.events as typeof events; return new Promise(() => {}); }
      if (command === "resolve_copy_conflict") return Promise.reject(new Error("stale nonce"));
      return Promise.resolve();
    });
    let promptSignal!: AbortSignal;
    const resultTask = copyEntries(["/src/a"], "/dest", {
      signal: new AbortController().signal, jobId: 10,
      onConflict: vi.fn(async (_info, signal) => { promptSignal = signal; return { choice: "overwrite" as const, applyToAll: false }; }),
    });
    await vi.waitFor(() => expect(events).toBeTypeOf("function"));
    events({ type: "conflict", item: 0, nonce: "bad", conflict: {
      fileName: "a", sourcePath: "/src/a", remaining: 0, sourceSize: 1, sourceModified: "now", destSize: 1, destModified: "now",
    } });
    const result = await resultTask;
    expect(result).toEqual({ ok: false, error: "stale nonce" });
    expect(promptSignal.aborted).toBe(true);
  });

  it("dismisses an unresolved prompt when native completion wins", async () => {
    let events!: (event: CopySessionEvent) => void;
    const pending = deferred<ReturnType<typeof reply>>();
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "copy_entries") { events = args.events as typeof events; return pending.promise; }
      return Promise.resolve();
    });
    let promptSignal!: AbortSignal;
    const task = copyEntries(["/src/a"], "/dest", {
      signal: new AbortController().signal, jobId: 11,
      onConflict: vi.fn((_info, signal) => {
        promptSignal = signal;
        return new Promise<import("$lib/domain/copy-session").CopyDecision>(() => {});
      }),
    });
    await vi.waitFor(() => expect(events).toBeTypeOf("function"));
    events({ type: "conflict", item: 0, nonce: "pending", conflict: {
      fileName: "a", sourcePath: "/src/a", remaining: 0, sourceSize: 1, sourceModified: "now", destSize: 1, destModified: "now",
    } });
    pending.resolve(reply());
    expect((await task).ok).toBe(true);
    expect(promptSignal.aborted).toBe(true);
  });

  it("accepts the next conflict emitted synchronously before the prior resolution acknowledges", async () => {
    let events!: (event: CopySessionEvent) => void;
    const pending = deferred<ReturnType<typeof reply>>();
    const conflict = { fileName: "a", sourcePath: "/src/a", remaining: 1, sourceSize: 1,
      sourceModified: "now", destSize: 1, destModified: "now" };
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "copy_entries") { events = args.events as typeof events; return pending.promise; }
      if (command === "resolve_copy_conflict" && args.nonce === "first") {
        events({ type: "conflict", item: 1, nonce: "second", conflict: { ...conflict, remaining: 0 } });
      }
      return Promise.resolve();
    });
    const onConflict = vi.fn(async () => ({ choice: "skip" as const, applyToAll: false }));
    const task = copyEntries(["/src/a", "/src/b"], "/dest", {
      signal: new AbortController().signal, jobId: 12, onConflict,
    });
    await vi.waitFor(() => expect(events).toBeTypeOf("function"));
    events({ type: "conflict", item: 0, nonce: "first", conflict });
    await vi.waitFor(() => expect(onConflict).toHaveBeenCalledTimes(2));
    expect(mocks.invoke).toHaveBeenCalledWith("resolve_copy_conflict", expect.objectContaining({ item: 1, nonce: "second" }));
    pending.resolve(reply());
    await task;
  });

  it.each([
    ["event callback", (onEvent: ReturnType<typeof vi.fn>, onConflict: ReturnType<typeof vi.fn>) => {
      onEvent.mockImplementation(() => { throw new Error("event callback failed"); });
    }],
    ["synchronous conflict callback", (_onEvent: ReturnType<typeof vi.fn>, onConflict: ReturnType<typeof vi.fn>) => {
      onConflict.mockImplementation(() => { throw new Error("conflict callback failed"); });
    }],
  ])("cancels native work when the %s fails", async (_label, configure) => {
    let events!: (event: CopySessionEvent) => void;
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "copy_entries") { events = args.events as typeof events; return new Promise(() => {}); }
      return Promise.resolve();
    });
    const onEvent = vi.fn<(event: CopySessionEvent) => void>();
    const onConflict = vi.fn(async () => ({ choice: "skip" as const, applyToAll: false }));
    configure(onEvent, onConflict);
    const task = copyEntries(["/src/a"], "/dest", {
      signal: new AbortController().signal, jobId: 13,
      onConflict, onEvent: _label === "event callback" ? onEvent : undefined,
    });
    await vi.waitFor(() => expect(events).toBeTypeOf("function"));
    events({ type: "ready" });
    if (_label.includes("conflict")) events({ type: "conflict", item: 0, nonce: "n", conflict: {
      fileName: "a", sourcePath: "/src/a", remaining: 0, sourceSize: 1, sourceModified: "now", destSize: 1, destModified: "now",
    } });
    expect((await task).ok).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_copy_session", { sessionId: "session-1", requestId: "request-1" });
  });
});
