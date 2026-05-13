import { describe, it, expect, vi } from "vitest";
import {
  executeUndo,
  executeRedo,
  type UndoApiDeps,
} from "$lib/domain/undo-operations";
import type { UndoAction } from "$lib/state/types";

/** Build a mock API where every function resolves to { ok: true }. */
function mockApi(): UndoApiDeps {
  return {
    renameEntry: vi.fn().mockResolvedValue({ ok: true }),
    moveEntry: vi.fn().mockResolvedValue({ ok: true }),
    deleteEntry: vi.fn().mockResolvedValue({ ok: true }),
    deleteMultipleEntries: vi.fn().mockResolvedValue({ ok: true }),
    restoreFromTrash: vi.fn().mockResolvedValue({ ok: true }),
  };
}

// --- executeUndo ---

describe("executeUndo", () => {
  it("calls renameEntry with path and oldName for rename actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "rename",
      path: "/docs/report.txt",
      oldName: "notes.txt",
      newName: "report.txt",
    };

    const result = await executeUndo(action, api);

    expect(result).toEqual({ ok: true });
    expect(api.renameEntry).toHaveBeenCalledWith("/docs/report.txt", "notes.txt");
  });

  it("calls moveEntry with destPath and originalDir for move actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "move",
      sourcePath: "/a/file.txt",
      destPath: "/b/file.txt",
      originalDir: "/a",
    };

    const result = await executeUndo(action, api);

    expect(result).toEqual({ ok: true });
    expect(api.moveEntry).toHaveBeenCalledWith("/b/file.txt", "/a");
  });

  it("calls deleteEntry with copiedPath for copy actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "copy",
      copiedPath: "/dest/file.txt",
      parentDir: "/dest",
    };

    const result = await executeUndo(action, api);

    expect(result).toEqual({ ok: true });
    expect(api.deleteEntry).toHaveBeenCalledWith("/dest/file.txt");
  });

  it("calls restoreFromTrash for delete actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "delete",
      paths: ["/a.txt", "/b.txt"],
      parentDir: "/",
    };

    const result = await executeUndo(action, api);

    expect(result).toEqual({ ok: true });
    expect(api.restoreFromTrash).toHaveBeenCalledWith(["/a.txt", "/b.txt"]);
  });

  it("undoes batch actions in reverse order", async () => {
    const callOrder: string[] = [];
    const api = mockApi();
    (api.renameEntry as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("rename");
      return { ok: true };
    });
    (api.deleteEntry as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("delete-copy");
      return { ok: true };
    });

    const action: UndoAction = {
      type: "batch",
      label: "test batch",
      actions: [
        { type: "rename", path: "/a/x.txt", oldName: "y.txt", newName: "x.txt" },
        { type: "copy", copiedPath: "/b/z.txt", parentDir: "/b" },
      ],
    };

    const result = await executeUndo(action, api);

    expect(result).toEqual({ ok: true });
    expect(callOrder).toEqual(["delete-copy", "rename"]);
  });

  it("aborts batch on first failure and returns the error", async () => {
    const api = mockApi();
    (api.deleteEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "permission denied",
    });

    const action: UndoAction = {
      type: "batch",
      label: "test batch",
      actions: [
        { type: "rename", path: "/a/x.txt", oldName: "y.txt", newName: "x.txt" },
        { type: "copy", copiedPath: "/b/z.txt", parentDir: "/b" },
      ],
    };

    const result = await executeUndo(action, api);

    expect(result).toEqual({ ok: false, error: "permission denied" });
    // rename (index 0) should NOT have been called because the batch reverses
    // and the copy undo (index 1, processed first) failed
    expect(api.renameEntry).not.toHaveBeenCalled();
  });

  it("propagates API errors", async () => {
    const api = mockApi();
    (api.renameEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "file not found",
    });

    const action: UndoAction = {
      type: "rename",
      path: "/gone.txt",
      oldName: "old.txt",
      newName: "gone.txt",
    };

    const result = await executeUndo(action, api);

    expect(result).toEqual({ ok: false, error: "file not found" });
  });
});

// --- executeRedo ---

describe("executeRedo", () => {
  it("renames from oldName back to newName for rename actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "rename",
      path: "/docs/report.txt",
      oldName: "notes.txt",
      newName: "report.txt",
    };

    const result = await executeRedo(action, api);

    expect(result).toEqual({ ok: true });
    // After undo, the file is at parentDir/oldName. Redo renames it to newName.
    expect(api.renameEntry).toHaveBeenCalledWith("/docs/notes.txt", "report.txt");
  });

  it("moves from originalDir back to destDir for move actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "move",
      sourcePath: "/a/file.txt",
      destPath: "/b/file.txt",
      originalDir: "/a",
    };

    const result = await executeRedo(action, api);

    expect(result).toEqual({ ok: true });
    // After undo, file is at originalDir/fileName. Redo moves it to destDir.
    expect(api.moveEntry).toHaveBeenCalledWith("/a/file.txt", "/b");
  });

  it("restores from trash for copy actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "copy",
      copiedPath: "/dest/file.txt",
      parentDir: "/dest",
    };

    const result = await executeRedo(action, api);

    expect(result).toEqual({ ok: true });
    expect(api.restoreFromTrash).toHaveBeenCalledWith(["/dest/file.txt"]);
  });

  it("re-deletes for delete actions", async () => {
    const api = mockApi();
    const action: UndoAction = {
      type: "delete",
      paths: ["/a.txt", "/b.txt"],
      parentDir: "/",
    };

    const result = await executeRedo(action, api);

    expect(result).toEqual({ ok: true });
    expect(api.deleteMultipleEntries).toHaveBeenCalledWith(["/a.txt", "/b.txt"]);
  });

  it("redoes batch actions in original order", async () => {
    const callOrder: string[] = [];
    const api = mockApi();
    (api.renameEntry as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("rename");
      return { ok: true };
    });
    (api.restoreFromTrash as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("restore");
      return { ok: true };
    });

    const action: UndoAction = {
      type: "batch",
      label: "test batch",
      actions: [
        { type: "rename", path: "/a/x.txt", oldName: "y.txt", newName: "x.txt" },
        { type: "copy", copiedPath: "/b/z.txt", parentDir: "/b" },
      ],
    };

    const result = await executeRedo(action, api);

    expect(result).toEqual({ ok: true });
    expect(callOrder).toEqual(["rename", "restore"]);
  });

  it("aborts batch on first failure and returns the error", async () => {
    const api = mockApi();
    (api.renameEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "disk full",
    });

    const action: UndoAction = {
      type: "batch",
      label: "test batch",
      actions: [
        { type: "rename", path: "/a/x.txt", oldName: "y.txt", newName: "x.txt" },
        { type: "copy", copiedPath: "/b/z.txt", parentDir: "/b" },
      ],
    };

    const result = await executeRedo(action, api);

    expect(result).toEqual({ ok: false, error: "disk full" });
    // Copy redo (restore) should not be called because rename failed first
    expect(api.restoreFromTrash).not.toHaveBeenCalled();
  });

  it("propagates API errors", async () => {
    const api = mockApi();
    (api.moveEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "target exists",
    });

    const action: UndoAction = {
      type: "move",
      sourcePath: "/a/file.txt",
      destPath: "/b/file.txt",
      originalDir: "/a",
    };

    const result = await executeRedo(action, api);

    expect(result).toEqual({ ok: false, error: "target exists" });
  });
});
