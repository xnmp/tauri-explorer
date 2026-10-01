import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import type { FileEntry, FileMutationReceipt } from "$lib/domain/file";

const copyEntries = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn(), broadcast: vi.fn() }));
const broadcast = vi.hoisted(() => vi.fn());
const prune = vi.hoisted(() => vi.fn());
vi.mock("$lib/api/copy-session", () => ({ copyEntries }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));
vi.mock("$lib/state/file-events", () => ({ broadcastFileChange: broadcast }));
vi.mock("$lib/state/frecency.svelte", () => ({ frecencyStore: { pruneNonExistent: prune } }));

import { copyFiles } from "$lib/state/copy-operations";
import { conflictResolver } from "$lib/state/conflict-resolver.svelte";
import { operationsManager } from "$lib/state/operations.svelte";

const entry = (name: string): FileEntry => ({ name, path: `/dest/${name}`, kind: "file", size: 1, modified: "now" });
const receipt = (name: string): FileMutationReceipt => ({ path: `/dest/${name}`, entry: entry(name) });
const success = (names: string[], extra: Partial<CopySessionOutcome> = {}) => ({ ok: true as const, data: {
  items: names.map((name) => ({ status: "succeeded" as const, receipt: receipt(name) })), cancelled: false, warnings: [], ...extra,
} });

beforeEach(() => {
  vi.clearAllMocks();
  for (const operation of [...operationsManager.operations]) operationsManager.clearOperation(operation.id);
  copyEntries.mockResolvedValue(success(["a.txt"]));
});

describe("copyFiles", () => {
  it("sends one ordered batch, publishes incremental entries, and leaves history native-owned", async () => {
    const added = vi.fn();
    copyEntries.mockImplementation(async (sources: string[], _dest: string, options: { onEvent: (event: CopySessionEvent) => void }) => {
      sources.forEach((source, item) => options.onEvent({ type: "completed", item, total: sources.length, entry: entry(source.split("/").pop()!) }));
      return success(["a.txt", "b.txt"]);
    });
    const refresh = vi.fn();
    await copyFiles(["/src/a.txt", "/src/b.txt"], "/dest", { onRefresh: refresh, onEntriesAdded: added });

    expect(copyEntries).toHaveBeenCalledOnce();
    expect(copyEntries.mock.calls[0][0]).toEqual(["/src/a.txt", "/src/b.txt"]);
    expect(copyEntries.mock.calls[0][1]).toBe("/dest");
    expect(added).toHaveBeenCalledTimes(2);
    expect(added.mock.calls.map(([entries]) => entries[0].name)).toEqual(["a.txt", "b.txt"]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
    expect(operationsManager.operations[0].status).toBe("completed");
  });

  it("keeps a successful prefix visible and reports a later failure", async () => {
    copyEntries.mockResolvedValue({ ok: true, data: { items: [
      { status: "succeeded", receipt: receipt("a.txt") },
      { status: "failed", error: "disk full" },
      { status: "unstarted" },
    ], cancelled: false, warnings: [] } });
    const error = await copyFiles(["/src/a.txt", "/src/b.txt", "/src/c.txt"], "/dest", { onRefresh: vi.fn() });
    expect(error).toContain("b.txt: disk full");
    expect(broadcast).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(operationsManager.operations[0].status).toBe("error");
  });

  it("keeps a successful prefix after cancellation without claiming full success", async () => {
    copyEntries.mockResolvedValue({ ok: true, data: { items: [
      { status: "succeeded", receipt: receipt("a.txt") }, { status: "unstarted" },
    ], cancelled: true, warnings: [] } });
    await copyFiles(["/src/a.txt", "/src/b.txt"], "/dest", { onRefresh: vi.fn() });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(toast.show).not.toHaveBeenCalled();
    expect(operationsManager.operations).toHaveLength(0);
  });

  it("shows warnings but no success toast when every item was skipped", async () => {
    copyEntries.mockResolvedValue({ ok: true, data: {
      items: [{ status: "skipped" }, { status: "skipped" }], cancelled: false, warnings: ["retention warning"],
    } });
    await copyFiles(["/src/a.txt", "/src/b.txt"], "/dest", { onRefresh: vi.fn() });
    expect(toast.show).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("retention warning");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("aborts immediately when cancelled while a conflict prompt is open without progress events", async () => {
    let signal!: AbortSignal;
    copyEntries.mockImplementation((_sources, _dest, options) => {
      signal = options.signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: true, data: {
        items: [{ status: "unstarted" }], cancelled: true, warnings: [],
      } }), { once: true }));
    });
    const task = copyFiles(["/src/a.txt"], "/dest", { onRefresh: vi.fn() });
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    operationsManager.cancelOperation(operationsManager.operations[0].id);
    expect(signal.aborted).toBe(true);
    await task;
  });

  it("passes the native prompt signal to the shared conflict resolver", async () => {
    const prompt = vi.spyOn(conflictResolver, "prompt").mockResolvedValueOnce({ choice: "skip", applyToAll: false });
    copyEntries.mockImplementation(async (_sources, _dest, options) => {
      const controller = new AbortController();
      await options.onConflict({ fileName: "a", sourcePath: "/src/a", remaining: 0,
        sourceSize: 1, sourceModified: "now", destSize: 1, destModified: "now" }, controller.signal);
      return { ok: true, data: { items: [{ status: "skipped" }], cancelled: false, warnings: [] } };
    });
    await copyFiles(["/src/a"], "/dest", { onRefresh: vi.fn() });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ fileName: "a" }), expect.any(AbortSignal));
    prompt.mockRestore();
  });
});
