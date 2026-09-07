import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UndoAction } from "$lib/state/types";

const api = vi.hoisted(() => ({
  renameEntry: vi.fn(),
  moveEntry: vi.fn(),
  deleteEntry: vi.fn(),
  deleteMultipleEntries: vi.fn(),
  restoreFromTrash: vi.fn(),
}));

vi.mock("$lib/api/files", () => api);

import { undoStore } from "$lib/state/undo.svelte";

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

function copied(path: string): UndoAction {
  return { type: "copy", copiedPath: path, parentDir: path.slice(0, path.lastIndexOf("/")) };
}

beforeEach(() => {
  undoStore.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  for (const mock of Object.values(api)) mock.mockResolvedValue({ ok: true });
  api.deleteMultipleEntries.mockImplementation(async (paths: string[]) => ({
    ok: true,
    data: { succeeded: paths, failed: [] },
  }));
  api.restoreFromTrash.mockImplementation(async (paths: string[]) => ({
    ok: true,
    data: { succeeded: paths, failed: [] },
  }));
});

afterEach(() => {
  undoStore.clear();
});

describe("undo operation ownership", () => {
  it("executes one inverse for concurrent undo requests against the same action", async () => {
    const inverse = deferred<{ ok: true }>();
    api.deleteEntry.mockReturnValue(inverse.promise);
    undoStore.push(copied("/a/a.txt"));

    const first = undoStore.undo();
    const concurrent = undoStore.undo();
    inverse.resolve({ ok: true });
    await Promise.allSettled([first, concurrent]);

    expect(api.deleteEntry).toHaveBeenCalledTimes(1);
    expect(api.deleteEntry).toHaveBeenCalledWith("/a/a.txt");
    expect(undoStore.stackSize).toBe(0);
    expect(undoStore.canUndo).toBe(false);
    expect(undoStore.canRedo).toBe(true);
  });

  it("retains a newer pushed action while an older undo is pending", async () => {
    const inverseA = deferred<{ ok: true }>();
    api.deleteEntry.mockReturnValueOnce(inverseA.promise);
    undoStore.push(copied("/a/a.txt"));

    const pendingA = undoStore.undo();
    undoStore.push(copied("/b/b.txt"));
    inverseA.resolve({ ok: true });
    await pendingA;

    expect.soft(undoStore.stackSize).toBe(1);
    expect.soft(undoStore.canUndo).toBe(true);
    api.deleteEntry.mockResolvedValueOnce({ ok: true });
    await undoStore.undo();
    expect(api.deleteEntry).toHaveBeenNthCalledWith(2, "/b/b.txt");
    expect(undoStore.canUndo).toBe(false);
  });

  it("does not remove post-clear history or resurrect redo when an older undo settles", async () => {
    const inverseA = deferred<{ ok: true }>();
    api.deleteEntry.mockReturnValueOnce(inverseA.promise);
    undoStore.push(copied("/a/a.txt"));

    const pendingA = undoStore.undo();
    undoStore.clear();
    undoStore.push(copied("/b/b.txt"));
    inverseA.resolve({ ok: true });
    await pendingA;

    expect.soft(undoStore.stackSize).toBe(1);
    expect.soft(undoStore.canUndo).toBe(true);
    expect.soft(undoStore.canRedo).toBe(false);
    api.deleteEntry.mockResolvedValueOnce({ ok: true });
    await undoStore.undo();
    expect(api.deleteEntry).toHaveBeenNthCalledWith(2, "/b/b.txt");
  });

  it("releases operation ownership after a rejected inverse so retry can succeed", async () => {
    const inverse = deferred<{ ok: true }>();
    api.deleteEntry.mockReturnValueOnce(inverse.promise);
    undoStore.push(copied("/a/retry.txt"));

    const rejected = undoStore.undo();
    inverse.reject(new Error("backend disconnected"));
    expect(await rejected).toEqual({ error: "backend disconnected" });
    expect(undoStore.stackSize).toBe(1);

    api.deleteEntry.mockResolvedValueOnce({ ok: true });
    const retried = await undoStore.undo();
    expect(retried).toEqual({ action: copied("/a/retry.txt") });
    expect(api.deleteEntry).toHaveBeenCalledTimes(2);
    expect(undoStore.canUndo).toBe(false);
    expect(undoStore.canRedo).toBe(true);
  });

  it("retries only the unfinished suffix of a partially successful batch inverse", async () => {
    const inverseCalls = new Map<string, number>();
    api.deleteEntry.mockImplementation(async (path: string) => {
      const count = (inverseCalls.get(path) ?? 0) + 1;
      inverseCalls.set(path, count);
      if (path === "/batch/b.txt" && count === 1) {
        return { ok: false, error: "b is temporarily locked" };
      }
      return { ok: true };
    });
    const batch: UndoAction = {
      type: "batch",
      label: "Copied two files",
      // Undo runs in reverse: A succeeds, then B fails.
      actions: [copied("/batch/b.txt"), copied("/batch/a.txt")],
    };
    undoStore.push(batch);

    const partial = await undoStore.undo();
    expect(partial.error).toBe("b is temporarily locked");
    expect(partial.action).toBeDefined();
    expect.soft(inverseCalls.get("/batch/a.txt")).toBe(1);
    expect.soft(inverseCalls.get("/batch/b.txt")).toBe(1);
    expect.soft(undoStore.stackSize).toBe(1);
    expect.soft(undoStore.canRedo).toBe(true);

    const retried = await undoStore.undo();
    expect(retried.error).toBeUndefined();
    expect(retried.action).toBeDefined();
    expect(inverseCalls.get("/batch/a.txt")).toBe(1);
    expect(inverseCalls.get("/batch/b.txt")).toBe(2);
    expect(undoStore.canUndo).toBe(false);
    expect(undoStore.canRedo).toBe(true);

    await undoStore.redo();
    await undoStore.redo();
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(1, ["/batch/b.txt"]);
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(2, ["/batch/a.txt"]);
    expect(undoStore.canRedo).toBe(false);
  });

  it("retries only the unfinished suffix of a partially successful batch redo", async () => {
    const batch: UndoAction = {
      type: "batch",
      label: "Copied two files",
      actions: [copied("/batch/b.txt"), copied("/batch/a.txt")],
    };
    undoStore.push(batch);
    await undoStore.undo();
    api.deleteEntry.mockClear();
    const restoreCalls = new Map<string, number>();
    api.restoreFromTrash.mockImplementation(async (paths: string[]) => {
      const path = paths[0];
      const count = (restoreCalls.get(path) ?? 0) + 1;
      restoreCalls.set(path, count);
      if (path === "/batch/a.txt" && count === 1) {
        return { ok: true, data: { succeeded: [], failed: [{ path, error: "a is temporarily locked" }] } };
      }
      return { ok: true, data: { succeeded: paths, failed: [] } };
    });

    const partial = await undoStore.redo();
    expect(partial.error).toContain("a is temporarily locked");
    expect(partial.action).toBeDefined();
    expect.soft(restoreCalls.get("/batch/b.txt")).toBe(1);
    expect.soft(restoreCalls.get("/batch/a.txt")).toBe(1);
    expect.soft(undoStore.canUndo).toBe(true);
    expect.soft(undoStore.canRedo).toBe(true);

    const retried = await undoStore.redo();
    expect(retried.error).toBeUndefined();
    expect(restoreCalls.get("/batch/b.txt")).toBe(1);
    expect(restoreCalls.get("/batch/a.txt")).toBe(2);
    expect(undoStore.canRedo).toBe(false);

    await undoStore.undo();
    await undoStore.undo();
    expect(api.deleteEntry).toHaveBeenNthCalledWith(1, "/batch/a.txt");
    expect(api.deleteEntry).toHaveBeenNthCalledWith(2, "/batch/b.txt");
  });

  it("preserves a new undo branch while an older redo is pending", async () => {
    undoStore.push(copied("/a/a.txt"));
    await undoStore.undo();
    api.deleteEntry.mockClear();
    const restoreA = deferred<{ ok: true; data: { succeeded: string[]; failed: [] } }>();
    api.restoreFromTrash.mockReturnValueOnce(restoreA.promise);

    const pendingA = undoStore.redo();
    undoStore.push(copied("/b/b.txt"));
    expect.soft(undoStore.canUndo).toBe(false);
    expect.soft(undoStore.canRedo).toBe(false);
    restoreA.resolve({ ok: true, data: { succeeded: ["/a/a.txt"], failed: [] } });
    await pendingA;

    expect.soft(undoStore.stackSize).toBe(2);
    expect.soft(undoStore.canUndo).toBe(true);
    expect.soft(undoStore.canRedo).toBe(false);
    await undoStore.undo();
    await undoStore.undo();
    expect(api.deleteEntry).toHaveBeenNthCalledWith(1, "/a/a.txt");
    expect(api.deleteEntry).toHaveBeenNthCalledWith(2, "/b/b.txt");
  });

  it("retains unfinished partial redo work when a new action is pushed during the operation", async () => {
    const batch: UndoAction = {
      type: "batch",
      label: "Copied two files",
      actions: [copied("/batch/a.txt"), copied("/batch/b.txt")],
    };
    undoStore.push(batch);
    await undoStore.undo();
    const restoreA = deferred<{ ok: true; data: { succeeded: string[]; failed: [] } }>();
    api.restoreFromTrash
      .mockReturnValueOnce(restoreA.promise)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          succeeded: [],
          failed: [{ path: "/batch/b.txt", error: "b restore failed" }],
        },
      })
      .mockImplementation(async (paths: string[]) => ({ ok: true, data: { succeeded: paths, failed: [] } }));

    const pendingRedo = undoStore.redo();
    undoStore.push(copied("/new/new.txt"));
    restoreA.resolve({ ok: true, data: { succeeded: ["/batch/a.txt"], failed: [] } });
    const partial = await pendingRedo;

    expect(partial.error).toContain("b restore failed");
    expect(partial.action).toBeDefined();
    expect.soft(undoStore.canUndo).toBe(true);
    expect.soft(undoStore.canRedo).toBe(true);

    const retried = await undoStore.redo();
    expect(retried.error).toBeUndefined();
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(1, ["/batch/a.txt"]);
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(2, ["/batch/b.txt"]);
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(3, ["/batch/b.txt"]);
    expect(undoStore.canRedo).toBe(false);
  });

  it("retains a wholly failed redo when a new action is pushed during the operation", async () => {
    const batch: UndoAction = {
      type: "batch",
      label: "Copied two files",
      actions: [copied("/batch/a.txt"), copied("/batch/b.txt")],
    };
    undoStore.push(batch);
    await undoStore.undo();
    const restoreA = deferred<{ ok: true; data: { succeeded: string[]; failed: { path: string; error: string }[] } }>();
    api.restoreFromTrash
      .mockReturnValueOnce(restoreA.promise)
      .mockImplementation(async (paths: string[]) => ({ ok: true, data: { succeeded: paths, failed: [] } }));

    const pendingRedo = undoStore.redo();
    undoStore.push(copied("/new/new.txt"));
    restoreA.resolve({
      ok: true,
      data: { succeeded: [], failed: [{ path: "/batch/a.txt", error: "a restore failed" }] },
    });
    const failed = await pendingRedo;

    expect(failed.error).toContain("a restore failed");
    expect(failed.action).toBeUndefined();
    expect.soft(undoStore.canUndo).toBe(true);
    expect.soft(undoStore.canRedo).toBe(true);

    const retried = await undoStore.redo();
    expect(retried.error).toBeUndefined();
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(1, ["/batch/a.txt"]);
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(2, ["/batch/a.txt"]);
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(3, ["/batch/b.txt"]);
    expect(undoStore.canRedo).toBe(false);
  });

  it("retries only failed paths from a partial multi-path delete undo and preserves redo order", async () => {
    const action: UndoAction = { type: "delete", paths: ["/trash/a.txt", "/trash/b.txt"], parentDir: "/trash" };
    undoStore.push(action);
    api.restoreFromTrash
      .mockResolvedValueOnce({
        ok: true,
        data: { succeeded: ["/trash/a.txt"], failed: [{ path: "/trash/b.txt", error: "b restore failed" }] },
      })
      .mockImplementation(async (paths: string[]) => ({ ok: true, data: { succeeded: paths, failed: [] } }));

    const partial = await undoStore.undo();
    expect(partial.error).toContain("b restore failed");
    expect(partial.action).toBeDefined();
    expect.soft(undoStore.canUndo).toBe(true);
    expect.soft(undoStore.canRedo).toBe(true);
    const retried = await undoStore.undo();
    expect(retried.error).toBeUndefined();
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(1, ["/trash/a.txt", "/trash/b.txt"]);
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(2, ["/trash/b.txt"]);

    await undoStore.redo();
    await undoStore.redo();
    expect(api.deleteMultipleEntries).toHaveBeenNthCalledWith(1, ["/trash/b.txt"]);
    expect(api.deleteMultipleEntries).toHaveBeenNthCalledWith(2, ["/trash/a.txt"]);
  });

  it("retries only failed paths from a partial multi-path delete redo and preserves undo order", async () => {
    const action: UndoAction = { type: "delete", paths: ["/trash/a.txt", "/trash/b.txt"], parentDir: "/trash" };
    undoStore.push(action);
    await undoStore.undo();
    api.restoreFromTrash.mockClear();
    api.deleteMultipleEntries
      .mockResolvedValueOnce({
        ok: true,
        data: { succeeded: ["/trash/a.txt"], failed: [{ path: "/trash/b.txt", error: "b delete failed" }] },
      })
      .mockImplementation(async (paths: string[]) => ({ ok: true, data: { succeeded: paths, failed: [] } }));

    const partial = await undoStore.redo();
    expect(partial.error).toContain("b delete failed");
    expect(partial.action).toBeDefined();
    expect.soft(undoStore.canUndo).toBe(true);
    expect.soft(undoStore.canRedo).toBe(true);
    const retried = await undoStore.redo();
    expect(retried.error).toBeUndefined();
    expect(api.deleteMultipleEntries).toHaveBeenNthCalledWith(1, ["/trash/a.txt", "/trash/b.txt"]);
    expect(api.deleteMultipleEntries).toHaveBeenNthCalledWith(2, ["/trash/b.txt"]);

    await undoStore.undo();
    await undoStore.undo();
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(1, ["/trash/b.txt"]);
    expect(api.restoreFromTrash).toHaveBeenNthCalledWith(2, ["/trash/a.txt"]);
  });
});
