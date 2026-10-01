import { describe, expect, it, vi } from "vitest";
import type { HistoryPort, HistoryReply, HistorySummary } from "$lib/domain/file-history";

const defaultPort = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  push: vi.fn(),
  clear: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("$lib/api/file-history", () => ({ fileHistoryPort: defaultPort }));

import { createUndoStore } from "$lib/state/undo.svelte";

function summary(
  revision: number,
  overrides: Partial<Omit<HistorySummary, "revision">> = {},
): HistorySummary {
  return { revision, undoId: null, redoId: null, stackSize: 0, busy: false, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function windowProjection() {
  let receive: (state: HistorySummary) => void = () => {};
  const port = {
    subscribe: vi.fn<HistoryPort["subscribe"]>((listener) => {
      receive = listener;
      return () => {};
    }),
    push: vi.fn<HistoryPort["push"]>(),
    clear: vi.fn<HistoryPort["clear"]>(),
    execute: vi.fn<HistoryPort["execute"]>(),
  } satisfies HistoryPort;
  return {
    port,
    store: createUndoStore(port, vi.fn()),
    publish: (state: HistorySummary) => receive(state),
  };
}

describe("cross-window native history projection", () => {
  it("mirrors a shared native entry and its global execution state in each window", async () => {
    const windowA = windowProjection();
    const windowB = windowProjection();
    const shared = summary(1, { undoId: 70, stackSize: 1 });
    windowA.publish(shared);
    windowB.publish(shared);
    expect.soft(windowA.store.canUndo).toBe(true);
    expect.soft(windowB.store.canUndo).toBe(true);

    const execution = deferred<HistoryReply>();
    windowA.port.execute.mockReturnValueOnce(execution.promise);
    const undo = windowA.store.undo();
    await Promise.resolve();
    expect(windowA.port.execute).toHaveBeenCalledWith("undo", 70);

    windowA.publish(summary(2, { undoId: 70, stackSize: 1, busy: true }));
    windowB.publish(summary(2, { undoId: 70, stackSize: 1, busy: true }));
    expect.soft(windowA.store.canUndo).toBe(false);
    expect.soft(windowB.store.canUndo).toBe(false);

    const settled = summary(3, { redoId: 71 });
    windowB.publish(settled);
    execution.resolve({ summary: settled, action: { type: "copy", copiedPath: "/shared/report.txt", parentDir: "/shared" } });
    await undo;
    expect.soft(windowA.store.canRedo).toBe(true);
    expect.soft(windowB.store.canRedo).toBe(true);
    expect(windowB.port.execute).not.toHaveBeenCalled();
  });

  it("keeps window-local native projections distinct at the same revision", () => {
    const windowA = windowProjection();
    const windowB = windowProjection();
    windowA.publish(summary(8, { undoId: 81, stackSize: 2 }));
    windowB.publish(summary(8));

    expect.soft(windowA.store.stackSize).toBe(2);
    expect.soft(windowA.store.canUndo).toBe(true);
    expect.soft(windowB.store.stackSize).toBe(0);
    expect(windowB.store.canUndo).toBe(false);
  });
});
