/**
 * moveFiles (#685) is the presentation half of an ordered native move
 * session. Its contract: one session per request, both directories of every
 * committed item refreshed, no renderer-owned inverse, and a cut clipboard
 * cleared only when every requested item actually arrived.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import type { FileEntry, FileMutationReceipt } from "$lib/domain/file";

const moveEntries = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn(), broadcast: vi.fn() }));
const broadcast = vi.hoisted(() => vi.fn());
const undo = vi.hoisted(() => ({ push: vi.fn(), pushAndBroadcast: vi.fn() }));
vi.mock("$lib/api/move-session", () => ({ moveEntries }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));
vi.mock("$lib/state/file-events", () => ({ broadcastFileChange: broadcast }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));
vi.mock("$lib/state/frecency.svelte", () => ({ frecencyStore: { pruneNonExistent: vi.fn() } }));

import { moveFiles } from "$lib/state/move-operations";
import { operationsManager } from "$lib/state/operations.svelte";

const entry = (name: string): FileEntry => ({ name, path: `/dest/${name}`, kind: "file", size: 1, modified: "now" });
const receipt = (name: string): FileMutationReceipt => ({ path: `/dest/${name}`, entry: entry(name) });
const outcome = (items: CopySessionOutcome["items"], extra: Partial<CopySessionOutcome> = {}) =>
  ({ ok: true as const, data: { items, cancelled: false, warnings: [], ...extra } });

beforeEach(() => {
  vi.clearAllMocks();
  for (const operation of [...operationsManager.operations]) operationsManager.clearOperation(operation.id);
  moveEntries.mockResolvedValue(outcome([{ status: "succeeded", receipt: receipt("a.txt") }]));
});

describe("moveFiles", () => {
  it("sends one ordered batch and publishes each entry as it lands", async () => {
    const added = vi.fn();
    moveEntries.mockImplementation(async (sources: string[], _dest: string, options: { onEvent: (event: CopySessionEvent) => void }) => {
      sources.forEach((source, item) => options.onEvent({ type: "completed", item, total: sources.length, entry: entry(source.split("/").pop()!) }));
      return outcome(["a.txt", "b.txt"].map((name) => ({ status: "succeeded" as const, receipt: receipt(name) })));
    });
    const refresh = vi.fn();
    const result = await moveFiles(["/src/a.txt", "/src/b.txt"], "/dest", { onRefresh: refresh, onEntriesAdded: added });

    expect(moveEntries).toHaveBeenCalledOnce();
    expect(moveEntries.mock.calls[0][0]).toEqual(["/src/a.txt", "/src/b.txt"]);
    expect(added.mock.calls.map(([entries]) => entries[0].name)).toEqual(["a.txt", "b.txt"]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(result).toEqual({ error: null, complete: true });
    expect(operationsManager.operations[0].status).toBe("completed");
  });

  it("reports byte progress from the session and settles the operation at 100%", async () => {
    const seen: number[] = [];
    const bytes: (number | undefined)[] = [];
    moveEntries.mockImplementation(async (sources: string[], _dest: string, options: { onEvent: (event: CopySessionEvent) => void }) => {
      sources.forEach((source, item) => {
        options.onEvent({ type: "progress", item, progress: { jobId: 1, bytesDone: 512, bytesTotal: 1024, currentFile: source } });
        seen.push(operationsManager.operations[0].progress);
        bytes.push(operationsManager.operations[0].totalBytes);
        options.onEvent({ type: "completed", item, total: sources.length, entry: entry(source.split("/").pop()!) });
      });
      return outcome(["a.txt", "b.txt"].map((name) => ({ status: "succeeded" as const, receipt: receipt(name) })));
    });
    await moveFiles(["/src/a.txt", "/src/b.txt"], "/dest", { onRefresh: vi.fn() });
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(operationsManager.operations[0].progress).toBe(100);
    expect(bytes).toEqual([1024, 1024]);
  });

  it("refreshes the vacated source directory as well as the destination", async () => {
    await moveFiles(["/src/a.txt"], "/dest", { onRefresh: vi.fn() });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast.mock.calls[0][0]).toEqual(expect.arrayContaining(["/src", "/dest"]));
  });

  it("never records a renderer-owned inverse", async () => {
    await moveFiles(["/src/a.txt"], "/dest", { onRefresh: vi.fn() });
    expect(undo.push).not.toHaveBeenCalled();
    expect(undo.pushAndBroadcast).not.toHaveBeenCalled();
  });

  it("reports an incomplete request so a cut clipboard survives it", async () => {
    moveEntries.mockResolvedValue(outcome([
      { status: "succeeded", receipt: receipt("a.txt") },
      { status: "unstarted" },
    ], { cancelled: true }));
    const result = await moveFiles(["/src/a.txt", "/src/b.txt"], "/dest", { onRefresh: vi.fn() });
    expect(result.complete).toBe(false);
    expect(result.error).toBeNull();
    // The prefix committed, so its directories still refresh.
    expect(broadcast).toHaveBeenCalledOnce();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("keeps a committed prefix visible while reporting a later failure", async () => {
    moveEntries.mockResolvedValue(outcome([
      { status: "succeeded", receipt: receipt("a.txt") },
      { status: "failed", error: "permission denied" },
    ]));
    const result = await moveFiles(["/src/a.txt", "/src/b.txt"], "/dest", { onRefresh: vi.fn() });
    expect(result.error).toContain("b.txt: permission denied");
    expect(result.complete).toBe(false);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
    expect(operationsManager.operations[0].status).toBe("error");
  });

  it("surfaces a transport failure without claiming anything moved", async () => {
    moveEntries.mockResolvedValue({ ok: false, error: "session refused" });
    const refresh = vi.fn();
    const result = await moveFiles(["/src/a.txt"], "/dest", { onRefresh: refresh });
    expect(result).toEqual({ error: "session refused", complete: false });
    expect(broadcast).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not open a session for an empty selection", async () => {
    const result = await moveFiles([], "/dest", { onRefresh: vi.fn() });
    expect(moveEntries).not.toHaveBeenCalled();
    expect(result).toEqual({ error: null, complete: true });
  });
});
