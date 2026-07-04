/**
 * Large cut/paste progress flow (#165): pasteEntries drives the operations
 * store with byte-level progress, settles the operation on completion,
 * cancellation stops the batch mid-way, and error paths surface without
 * losing the successful items. Observable via operationsManager state and
 * the recorded undo — not implementation internals.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const transfer = vi.hoisted(() => vi.fn());
const undo = vi.hoisted(() => ({ push: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const estimate = vi.hoisted(() => vi.fn());

vi.mock("$lib/state/file-transfer", () => ({ performFileTransfer: transfer }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));
vi.mock("$lib/state/file-events", () => ({ broadcastFileChange: vi.fn() }));
vi.mock("$lib/state/frecency.svelte", () => ({ frecencyStore: { pruneNonExistent: vi.fn() } }));
vi.mock("$lib/state/conflict-resolver.svelte", () => ({
  conflictResolver: { prompt: vi.fn() },
}));
vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  estimateSize: estimate,
}));

import { pasteEntries, type PasteSource } from "$lib/state/paste-operations";
import { operationsManager } from "$lib/state/operations.svelte";

function sources(n: number): PasteSource[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `file-${i}.bin`,
    path: `/src/file-${i}.bin`,
    size: 1024,
    modified: "2024-01-01T00:00:00.000Z",
  }));
}

const context = () => ({
  destPath: "/dest",
  existingEntries: [],
  onEntriesAdded: vi.fn(),
  onRefresh: vi.fn(async () => {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  // Settle any operations left over from a previous test.
  for (const op of [...operationsManager.operations]) {
    operationsManager.clearOperation(op.id);
  }
  estimate.mockResolvedValue({ ok: true, data: { totalBytes: 50 * 1024 } });
  transfer.mockImplementation(async (path: string) => ({
    ok: true,
    entry: { path: `/dest/${path.split("/").pop()}`, name: path.split("/").pop() },
  }));
});

describe("large paste progress", () => {
  it("tracks byte progress to completion and records one batch undo for 50 items", async () => {
    const progressSeen: number[] = [];
    transfer.mockImplementation(async (path: string) => {
      const op = operationsManager.operations[0];
      if (op) progressSeen.push(op.progress);
      return {
        ok: true,
        entry: { path: `/dest/${path.split("/").pop()}`, name: path.split("/").pop() },
      };
    });

    const ctx = context();
    const error = await pasteEntries(sources(50), true, ctx);

    expect(error).toBeNull();
    const op = operationsManager.operations[0];
    expect(op.status).toBe("completed");
    expect(op.progress).toBe(100);
    expect(op.totalBytes).toBe(50 * 1024);
    // Progress increased monotonically while the batch ran.
    expect(progressSeen.length).toBe(50);
    expect([...progressSeen]).toEqual([...progressSeen].sort((a, b) => a - b));

    // One batch undo covering all 50 moves; entries reported to the pane.
    expect(undo.push).toHaveBeenCalledTimes(1);
    expect(undo.push.mock.calls[0][0]).toMatchObject({ type: "batch" });
    expect(undo.push.mock.calls[0][0].actions).toHaveLength(50);
    expect(ctx.onEntriesAdded).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Pasted successfully");
  });

  it("cancellation mid-batch stops transferring and settles as cancelled", async () => {
    let calls = 0;
    transfer.mockImplementation(async (path: string) => {
      calls++;
      if (calls === 10) {
        operationsManager.cancelOperation(operationsManager.operations[0].id);
      }
      return {
        ok: true,
        entry: { path: `/dest/${path.split("/").pop()}`, name: path.split("/").pop() },
      };
    });

    await pasteEntries(sources(50), true, context());

    // The loop noticed the cancel on the next iteration — nowhere near 50.
    expect(calls).toBeLessThanOrEqual(11);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("partial failures complete the batch, surface one error toast, and keep successful undos", async () => {
    let i = 0;
    transfer.mockImplementation(async (path: string) => {
      i++;
      if (i % 2 === 0) return { ok: false, error: "disk full" };
      return {
        ok: true,
        entry: { path: `/dest/${path.split("/").pop()}`, name: path.split("/").pop() },
      };
    });

    const error = await pasteEntries(sources(10), false, context());

    expect(error).toContain("disk full");
    expect(toast.error).toHaveBeenCalledTimes(1);
    // The 5 successes are still undoable.
    expect(undo.push.mock.calls[0][0].actions).toHaveLength(5);
  });

  it("total failure marks the operation failed", async () => {
    transfer.mockResolvedValue({ ok: false, error: "permission denied" });

    await pasteEntries(sources(5), false, context());

    const op = operationsManager.operations[0];
    expect(op.status).toBe("error");
    expect(op.error).toContain("permission denied");
    expect(undo.push).not.toHaveBeenCalled();
  });

  it("estimate failure still runs the batch with file-level progress", async () => {
    estimate.mockResolvedValue({ ok: false, error: "nope" });

    const error = await pasteEntries(sources(4), true, context());

    expect(error).toBeNull();
    const op = operationsManager.operations[0];
    expect(op.status).toBe("completed");
    expect(op.progress).toBe(100);
    expect(op.totalBytes).toBeUndefined();
  });
});
