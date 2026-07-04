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
const cancelCopy = vi.hoisted(() => vi.fn());
// Capture the `copy-progress` listener the paste loop registers, so tests can
// drive backend byte-progress events synchronously.
const copyProgress = vi.hoisted(() => ({
  cb: null as null | ((e: { payload: unknown }) => void),
  unlisten: vi.fn(),
}));

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
  cancelCopy,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "copy-progress") copyProgress.cb = cb;
    return copyProgress.unlisten;
  }),
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
  copyProgress.cb = null;
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

  it("refines progress from copy-progress byte events for a single large file", async () => {
    estimate.mockResolvedValue({ ok: true, data: { totalBytes: 1024 } });
    let seenMidFile = 0;
    transfer.mockImplementation(
      async (_p: string, _d: string, _c: boolean, opts: { jobId: number }) => {
        // Backend reports the copy is half done for THIS file's job.
        copyProgress.cb?.({
          payload: { jobId: opts.jobId, bytesDone: 512, bytesTotal: 1024, currentFile: "/src/a" },
        });
        seenMidFile = operationsManager.operations[0].progress;
        return { ok: true, entry: { path: "/dest/a", name: "a" } };
      },
    );

    // Single source: intra-file 50% must surface as ~50% overall, not 0%.
    const error = await pasteEntries(
      [{ name: "a", path: "/src/a", size: 1024 }],
      false,
      context(),
    );

    expect(error).toBeNull();
    expect(seenMidFile).toBeCloseTo(50, 0);
    expect(copyProgress.unlisten).toHaveBeenCalled();
  });

  it("relays a mid-file cancel to the backend via cancelCopy", async () => {
    let capturedJobId = 0;
    transfer.mockImplementation(
      async (_p: string, _d: string, _c: boolean, opts: { jobId: number }) => {
        capturedJobId = opts.jobId;
        // User cancels the dialog while this file is copying.
        operationsManager.cancelOperation(operationsManager.operations[0].id);
        // A subsequent byte event should be relayed as a backend cancel.
        copyProgress.cb?.({
          payload: { jobId: opts.jobId, bytesDone: 1, bytesTotal: 1024, currentFile: "/src/a" },
        });
        return { ok: false, error: "Copy cancelled" };
      },
    );

    await pasteEntries([{ name: "a", path: "/src/a", size: 1024 }], false, context());

    expect(cancelCopy).toHaveBeenCalledWith(capturedJobId);
    // A cancelled copy is not reported as a failure toast.
    expect(toast.error).not.toHaveBeenCalled();
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
