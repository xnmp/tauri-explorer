/**
 * Tests for cancelled-operation id lifecycle.
 *
 * Cancelled ids must stay observable long enough for in-flight workers to
 * notice the cancellation, then expire so the set can't grow unbounded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { operationsManager } from "$lib/state/operations.svelte";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("operationsManager cancelled ids", () => {
  it("cancelOperation removes the row but keeps the id observable", () => {
    const op = operationsManager.startOperation("copy", "/src/a.txt", "/dest");

    operationsManager.cancelOperation(op.id);

    expect(operationsManager.operations.find((o) => o.id === op.id)).toBeUndefined();
    expect(operationsManager.isOperationCancelled(op.id)).toBe(true);
  });

  it("expires cancelled ids after the TTL", () => {
    const op = operationsManager.startOperation("move", "/src/b.txt", "/dest");

    operationsManager.cancelOperation(op.id);
    expect(operationsManager.isOperationCancelled(op.id)).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(operationsManager.isOperationCancelled(op.id)).toBe(false);
  });

  it("cancelAllOperations marks every running id and expires them too", () => {
    const a = operationsManager.startOperation("copy", "/src/a.txt", "/dest");
    const b = operationsManager.startOperation("copy", "/src/b.txt", "/dest");

    operationsManager.cancelAllOperations();

    expect(operationsManager.isOperationCancelled(a.id)).toBe(true);
    expect(operationsManager.isOperationCancelled(b.id)).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(operationsManager.isOperationCancelled(a.id)).toBe(false);
    expect(operationsManager.isOperationCancelled(b.id)).toBe(false);
  });

  it("notifies cancellation listeners immediately without requiring progress", () => {
    const op = operationsManager.startOperation("copy", "/src/paused.txt", "/dest");
    const listener = vi.fn();
    operationsManager.subscribeCancellation(op.id, listener);
    operationsManager.cancelOperation(op.id);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("invokes a late subscriber immediately for an already-cancelled id", () => {
    const op = operationsManager.startOperation("copy", "/src/paused.txt", "/dest");
    operationsManager.cancelOperation(op.id);
    const listener = vi.fn();
    operationsManager.subscribeCancellation(op.id, listener);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not notify an unsubscribed cancellation listener", () => {
    const op = operationsManager.startOperation("copy", "/src/paused.txt", "/dest");
    const listener = vi.fn();
    const unsubscribe = operationsManager.subscribeCancellation(op.id, listener);
    unsubscribe();
    operationsManager.cancelOperation(op.id);
    expect(listener).not.toHaveBeenCalled();
  });
});
