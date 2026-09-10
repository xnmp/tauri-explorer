import { describe, expect, it, vi } from "vitest";
import type { HistoryAction, HistoryPort, HistoryReply, HistorySummary, UndoAction } from "$lib/domain/file-history";

const defaultPort = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  push: vi.fn(),
  clear: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("$lib/api/file-history", () => ({ fileHistoryPort: defaultPort }));

import { createUndoStore } from "$lib/state/undo.svelte";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function summary(
  revision: number,
  overrides: Partial<Omit<HistorySummary, "revision">> = {},
): HistorySummary {
  return { revision, undoId: null, redoId: null, stackSize: 0, busy: false, ...overrides };
}

function reply(
  state: HistorySummary,
  action?: HistoryAction,
  error?: string,
  warnings?: readonly string[],
): HistoryReply {
  return {
    summary: state,
    ...(action ? { action } : {}),
    ...(error ? { error } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

function copied(path: string): UndoAction {
  return { type: "copy", copiedPath: path, parentDir: path.slice(0, path.lastIndexOf("/")) };
}

function harness() {
  let receive: (state: HistorySummary) => void = () => {};
  const unsubscribe = vi.fn();
  const port = {
    subscribe: vi.fn<HistoryPort["subscribe"]>((listener) => {
      receive = listener;
      return unsubscribe;
    }),
    push: vi.fn<HistoryPort["push"]>(),
    clear: vi.fn<HistoryPort["clear"]>(),
    execute: vi.fn<HistoryPort["execute"]>(),
  } satisfies HistoryPort;
  const report = vi.fn<(error: string) => void>();
  const store = createUndoStore(port, report);
  return { store, port, report, unsubscribe, publish: (state: HistorySummary) => receive(state) };
}

describe("native undo history projection", () => {
  it("invalidates redo for a committed effect without manufacturing an inverse", async () => {
    const { store, port, publish } = harness();
    publish(summary(1, { undoId: 10, redoId: 20, stackSize: 1 }));
    port.push.mockResolvedValueOnce(reply(summary(2, { undoId: 10, stackSize: 1 })));

    await store.invalidateRedo(true);

    expect(port.push).toHaveBeenCalledWith(null, true);
    expect(store.canRedo).toBe(false);
    expect(store.canUndo).toBe(true);
    expect(store.stackSize).toBe(1);
    expect(port.execute).not.toHaveBeenCalled();
  });

  it("accepts only summaries with a higher revision", () => {
    const { store, publish } = harness();
    publish(summary(4, { undoId: 40, stackSize: 2 }));
    publish(summary(3, { undoId: null, stackSize: 0 }));
    publish(summary(4, { undoId: null, stackSize: 0 }));

    expect.soft(store.stackSize).toBe(2);
    expect.soft(store.canUndo).toBe(true);
    publish(summary(5, { redoId: 41 }));
    expect.soft(store.stackSize).toBe(0);
    expect.soft(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
  });

  it("unsubscribes on disposal and ignores late stream and write replies", async () => {
    const { store, port, publish, unsubscribe } = harness();
    publish(summary(1, { undoId: 10, stackSize: 1 }));
    const pending = deferred<HistoryReply>();
    port.push.mockReturnValueOnce(pending.promise);
    const write = store.push(copied("/late/file.txt"));

    store.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    publish(summary(5, { undoId: 50, stackSize: 5 }));
    pending.resolve(reply(summary(6, { undoId: 60, stackSize: 6 })));
    await write;

    expect(store.stackSize).toBe(1);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it("snapshots a queued push before its caller mutates the action", async () => {
    const { store, port } = harness();
    const first = deferred<HistoryReply>();
    port.push
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(reply(summary(2, { undoId: 2, stackSize: 2 })));
    const firstWrite = store.push(copied("/queue/first.txt"));
    const paths = ["/queue/a.txt", "/queue/b.txt"];
    const queued: UndoAction = { type: "delete", paths, parentDir: "/queue" };
    const secondWrite = store.pushAndBroadcast(queued);
    paths[0] = "/mutated/a.txt";
    queued.parentDir = "/mutated";

    await Promise.resolve();
    expect(port.push).toHaveBeenCalledTimes(1);
    first.resolve(reply(summary(1, { undoId: 1, stackSize: 1 })));
    await firstWrite;
    await secondWrite;

    expect(port.push).toHaveBeenNthCalledWith(2, {
      type: "delete",
      paths: ["/queue/a.txt", "/queue/b.txt"],
      parentDir: "/queue",
    }, true);
  });

  it("executes the entry selected when intent was captured despite a newer streamed summary", async () => {
    const { store, port, publish } = harness();
    publish(summary(1, { undoId: 10, stackSize: 1 }));
    port.execute.mockResolvedValueOnce(reply(summary(3)));

    const undo = store.undo();
    publish(summary(2, { undoId: 20, stackSize: 2 }));
    await undo;

    expect(port.execute).toHaveBeenCalledOnce();
    expect(port.execute).toHaveBeenCalledWith("undo", 10);
  });

  it("waits for already admitted writes but excludes a later queued push from undo intent", async () => {
    const { store, port } = harness();
    const first = deferred<HistoryReply>();
    port.push
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(reply(summary(3, { undoId: 30, stackSize: 1 })));
    port.execute.mockResolvedValueOnce(reply(summary(2)));

    const firstWrite = store.push(copied("/queue/first.txt"));
    const undo = store.undo();
    const laterWrite = store.push(copied("/queue/later.txt"));
    expect(port.execute).not.toHaveBeenCalled();
    first.resolve(reply(summary(1, { undoId: 10, stackSize: 1 })));

    await firstWrite;
    await undo;
    await laterWrite;
    expect(port.execute).toHaveBeenCalledWith("undo", 10);
    expect(port.execute.mock.invocationCallOrder[0]).toBeLessThan(port.push.mock.invocationCallOrder[1]);
  });

  it("uses the admitted write receipt when a newer shared summary races its reply", async () => {
    const { store, port, publish } = harness();
    const pending = deferred<HistoryReply>();
    port.push.mockReturnValueOnce(pending.promise);
    port.execute.mockResolvedValueOnce(reply(summary(3), undefined, "File history changed"));
    const write = store.push(copied("/queue/local.txt"));
    const undo = store.undo();
    pending.resolve(reply(summary(1, { undoId: 10, stackSize: 1 })));
    // A native channel event may beat this window's IPC continuation.
    publish(summary(2, { undoId: 20, stackSize: 2 }));
    await write;
    await undo;
    expect(port.execute).toHaveBeenCalledWith("undo", 10);
  });

  it("suppresses a duplicate local request while an execution is pending", async () => {
    const { store, port, publish } = harness();
    publish(summary(1, { undoId: 10, stackSize: 1 }));
    const pending = deferred<HistoryReply>();
    port.execute.mockReturnValueOnce(pending.promise);

    const first = store.undo();
    const duplicate = await store.undo();
    expect(duplicate).toEqual({ error: "An undo or redo operation is already in progress" });
    expect(port.execute).toHaveBeenCalledTimes(1);
    pending.resolve(reply(summary(2, { redoId: 11 }), copied("/queue/file.txt")));
    await first;
    expect(store.canRedo).toBe(true);
  });

  it("presents a native replacement completion without pushing renderer authority", async () => {
    const { store, port, publish } = harness();
    const replacement: HistoryAction = { type: "replacement", path: "/dest/file.txt" };
    publish(summary(1, { undoId: 10, stackSize: 1 }));
    port.execute.mockResolvedValueOnce(reply(summary(2, { redoId: 11 }), replacement));

    expect(await store.undo()).toEqual({ action: replacement });
    expect(port.execute).toHaveBeenCalledWith("undo", 10);
    expect(port.push).not.toHaveBeenCalled();
    expect(store.canRedo).toBe(true);
  });

  it("preserves warnings independently from completion errors", async () => {
    const { store, port, publish } = harness();
    const action: HistoryAction = { type: "replacement", path: "/dest/file.txt" };
    publish(summary(1, { undoId: 10, stackSize: 1 }));
    port.execute
      .mockResolvedValueOnce(reply(summary(2, { redoId: 11 }), action, undefined, ["retained first", "retained second"]))
      .mockResolvedValueOnce(reply(summary(3, { redoId: 12 }), action, "restore failed", ["artifact retained"]));

    expect(await store.undo()).toEqual({
      action,
      warnings: ["retained first", "retained second"],
    });
    publish(summary(4, { undoId: 20, stackSize: 1 }));
    expect(await store.undo()).toEqual({
      action,
      error: "restore failed",
      warnings: ["artifact retained"],
    });
  });

  it("releases local execution ownership after a port rejection so retry can proceed", async () => {
    const { store, port, publish } = harness();
    publish(summary(1, { undoId: 10, stackSize: 1 }));
    port.execute
      .mockRejectedValueOnce(new Error("native channel closed"))
      .mockResolvedValueOnce(reply(summary(2, { redoId: 11 }), copied("/retry/file.txt")));

    expect(await store.undo()).toEqual({ error: "native channel closed" });
    expect(store.canUndo).toBe(true);
    expect(await store.undo()).toEqual({ action: copied("/retry/file.txt") });
    expect(port.execute).toHaveBeenNthCalledWith(1, "undo", 10);
    expect(port.execute).toHaveBeenNthCalledWith(2, "undo", 10);
    expect(store.canRedo).toBe(true);
  });

  it("serializes clear behind an admitted write and continues after a failed write", async () => {
    const { store, port, report } = harness();
    const pending = deferred<HistoryReply>();
    port.push.mockReturnValueOnce(pending.promise);
    port.clear.mockResolvedValueOnce(reply(summary(2)));

    const write = store.push(copied("/queue/file.txt"));
    const clear = store.clear();
    expect(port.clear).not.toHaveBeenCalled();
    pending.reject(new Error("push failed"));
    await write;
    await clear;

    expect(port.clear).toHaveBeenCalledOnce();
    expect(port.push.mock.invocationCallOrder[0]).toBeLessThan(port.clear.mock.invocationCallOrder[0]);
    expect(report).toHaveBeenCalledWith("Could not update Undo history: Error: push failed");
  });
});
