/**
 * handleFileDropMany (#163): a multi-item drag-and-drop must record ONE
 * undoable action (a batch) instead of one per item, with a single toast
 * and a single file-change broadcast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const transfer = vi.hoisted(() => vi.fn());
const undo = vi.hoisted(() => ({ push: vi.fn(), pushAndBroadcast: vi.fn() }));
const toast = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn(), broadcast: vi.fn() }));
const broadcast = vi.hoisted(() => vi.fn());

vi.mock("$lib/state/file-transfer", () => ({ performFileTransfer: transfer }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));
vi.mock("$lib/state/file-events", () => ({ broadcastFileChange: broadcast }));
vi.mock("$lib/state/frecency.svelte", () => ({ frecencyStore: { pruneNonExistent: vi.fn() } }));

import { handleFileDropMany } from "$lib/state/drop-operations";

beforeEach(() => {
  vi.clearAllMocks();
  transfer.mockImplementation(async (sourcePath: string, targetDir: string) => ({
    ok: true,
    entry: { path: `${targetDir}/${sourcePath.split("/").pop()}`, name: sourcePath.split("/").pop() },
  }));
});

const opts = () => ({ onRefresh: vi.fn() });

describe("handleFileDropMany", () => {
  it("records one batch undo action for a multi-item move", async () => {
    const options = opts();
    await handleFileDropMany(["/src/a.txt", "/src/b.txt", "/src/c.txt"], "/dest", false, options);

    expect(undo.push).toHaveBeenCalledTimes(1);
    const action = undo.push.mock.calls[0][0];
    expect(action.type).toBe("batch");
    expect(action.actions).toHaveLength(3);
    expect(action.actions.every((a: { type: string }) => a.type === "move")).toBe(true);
    // One toast, one refresh, one broadcast covering source + target dirs.
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(options.onRefresh).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toEqual(expect.arrayContaining(["/dest", "/src"]));
  });

  it("per-item side effects are suppressed during the batch", async () => {
    await handleFileDropMany(["/src/a.txt", "/src/b.txt"], "/dest", false, opts());
    for (const call of transfer.mock.calls) {
      expect(call[3]).toMatchObject({
        suppressUndo: true,
        suppressToast: true,
        suppressRefresh: true,
        suppressBroadcast: true,
      });
    }
  });

  it("a single-item drop keeps the plain per-item path (no batch wrapper)", async () => {
    await handleFileDropMany(["/src/a.txt"], "/dest", false, opts());
    // Delegated to handleFileDrop → performFileTransfer WITHOUT suppress flags.
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0][3].suppressUndo).toBeUndefined();
    expect(undo.push).not.toHaveBeenCalled(); // transfer records it internally
  });

  it("unwraps to a single action when all but one item is skipped", async () => {
    transfer
      .mockResolvedValueOnce({ ok: false, error: "skipped" })
      .mockResolvedValueOnce({ ok: true, entry: { path: "/dest/b.txt", name: "b.txt" } });

    await handleFileDropMany(["/src/a.txt", "/src/b.txt"], "/dest", false, opts());

    const action = undo.push.mock.calls[0][0];
    expect(action.type).toBe("move");
  });

  it("uses copy actions and pushAndBroadcast for cross-window copies", async () => {
    await handleFileDropMany(["/src/a.txt", "/src/b.txt"], "/dest", true, {
      onRefresh: vi.fn(),
      broadcastToOtherWindows: true,
    });

    expect(undo.pushAndBroadcast).toHaveBeenCalledTimes(1);
    const action = undo.pushAndBroadcast.mock.calls[0][0];
    expect(action.type).toBe("batch");
    expect(action.actions.every((a: { type: string }) => a.type === "copy")).toBe(true);
    expect(toast.broadcast).toHaveBeenCalledTimes(1);
  });

  it("reports failures once without recording undo for failed items", async () => {
    transfer
      .mockResolvedValueOnce({ ok: true, entry: { path: "/dest/a.txt", name: "a.txt" } })
      .mockResolvedValueOnce({ ok: false, error: "disk full" })
      .mockResolvedValueOnce({ ok: false, error: "disk full" });

    await handleFileDropMany(["/s/a.txt", "/s/b.txt", "/s/c.txt"], "/dest", false, opts());

    const action = undo.push.mock.calls[0][0];
    expect(action.type).toBe("move"); // only the one success
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).toContain("2");
  });

  it("does nothing for an empty path list", async () => {
    await handleFileDropMany([], "/dest", false, opts());
    expect(transfer).not.toHaveBeenCalled();
    expect(undo.push).not.toHaveBeenCalled();
  });
});
