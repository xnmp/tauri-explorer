/**
 * Progress dialog auto-hide: a finished operation lingers briefly (showing
 * "Complete") then auto-dismisses, and the panel hides once the last one
 * clears — even if an unrelated operation is still running (so one stuck
 * job can't pin a completed one on screen forever).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { operationsManager } from "$lib/state/operations.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  for (const op of [...operationsManager.operations]) operationsManager.clearOperation(op.id);
});

afterEach(() => {
  for (const op of [...operationsManager.operations]) operationsManager.clearOperation(op.id);
  vi.useRealTimers();
});

describe("progress dialog auto-hide", () => {
  it("a completed compress lingers then auto-dismisses and hides the panel", () => {
    const op = operationsManager.startOperation("compress", "/x/big");
    vi.advanceTimersByTime(1600); // dialog-show delay
    expect(operationsManager.showProgressDialog).toBe(true);

    operationsManager.updateProgress(op.id, 100, 100, 100);
    operationsManager.completeOperation(op.id);

    // Lingers visible right after completing.
    expect(operationsManager.operations.length).toBe(1);
    expect(operationsManager.showProgressDialog).toBe(true);

    // ...then auto-clears, and the now-empty panel hides.
    vi.advanceTimersByTime(2000);
    expect(operationsManager.operations.length).toBe(0);
    expect(operationsManager.showProgressDialog).toBe(false);
  });

  it("a completed op auto-dismisses even while another op is still running", () => {
    const stuck = operationsManager.startOperation("copy", "/x/stuck");
    const done = operationsManager.startOperation("extract", "/x/done.zip");
    vi.advanceTimersByTime(1600);

    operationsManager.completeOperation(done.id);
    vi.advanceTimersByTime(2000);

    // The completed extract is gone; the stuck copy (and the panel) remain.
    expect(operationsManager.operations.map((o) => o.id)).toEqual([stuck.id]);
    expect(operationsManager.showProgressDialog).toBe(true);
  });
});
