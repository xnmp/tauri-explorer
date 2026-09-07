import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { FileEntry, FileMutationReceipt } from "$lib/domain/file";
import type {
  HistoryPort,
  HistoryReply,
  HistorySummary,
  UndoAction,
} from "$lib/domain/file-history";
import type {
  DirectoryListingCallbacks,
  DirectoryListingResult,
} from "$lib/state/directory-listing";

type Load = (
  path: string,
  callbacks: DirectoryListingCallbacks,
) => Promise<DirectoryListingResult>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  load: { current: (async () => ({ ok: false, error: "unset" })) as Load },
  cleanup: vi.fn(async () => {}),
  renameEntry: vi.fn(),
  deleteEntry: vi.fn(),
  deleteMultipleEntries: vi.fn(),
  deleteEntryPermanent: vi.fn(),
}));

const history = vi.hoisted(() => {
  let revision = 0;
  let nextEntryId = 0;
  let undoId: number | null = null;
  let stackSize = 0;
  let receive: ((summary: HistorySummary) => void) | undefined;
  let queuedExecution: Pick<HistoryReply, "action" | "error"> | undefined;

  const summary = (): HistorySummary => ({
    revision,
    undoId,
    redoId: null,
    stackSize,
    busy: false,
  });
  const advance = (next: Omit<HistorySummary, "revision">): HistorySummary => {
    revision += 1;
    undoId = next.undoId;
    stackSize = next.stackSize;
    return { revision, ...next };
  };
  const port = {
    subscribe: vi.fn((listener: (next: HistorySummary) => void) => {
      receive = listener;
      listener(summary());
      return () => {
        if (receive === listener) receive = undefined;
      };
    }),
    push: vi.fn(async (_action: UndoAction, _shared: boolean): Promise<HistoryReply> => {
      nextEntryId += 1;
      return {
        summary: advance({
          undoId: nextEntryId,
          redoId: null,
          stackSize: stackSize + 1,
          busy: false,
        }),
      };
    }),
    clear: vi.fn(async (): Promise<HistoryReply> => ({
      summary: advance({ undoId: null, redoId: null, stackSize: 0, busy: false }),
    })),
    execute: vi.fn(async (): Promise<HistoryReply> => {
      if (!queuedExecution) throw new Error("Test must provide the native history outcome");
      const outcome = queuedExecution;
      queuedExecution = undefined;
      return {
        summary: advance({ undoId: null, redoId: nextEntryId, stackSize: 0, busy: false }),
        ...outcome,
      };
    }),
  } satisfies HistoryPort;

  return {
    port,
    queueExecution(action: UndoAction, error?: string) {
      queuedExecution = { action, ...(error ? { error } : {}) };
    },
    currentUndoId: () => undoId,
    resetCalls() {
      port.push.mockClear();
      port.clear.mockClear();
      port.execute.mockClear();
      queuedExecution = undefined;
    },
  };
});

vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: (path: string, callbacks: DirectoryListingCallbacks) =>
      mocks.load.current(path, callbacks),
    cleanup: mocks.cleanup,
  }),
}));

vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/files")>()),
  renameEntry: mocks.renameEntry,
  deleteEntry: mocks.deleteEntry,
  deleteMultipleEntries: mocks.deleteMultipleEntries,
  deleteEntryPermanent: mocks.deleteEntryPermanent,
}));

vi.mock("$lib/api/file-history", () => ({ fileHistoryPort: history.port }));

import {
  createExplorerState,
  type ExplorerInstance,
} from "$lib/state/explorer.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { clipboardStore } from "$lib/state/clipboard.svelte";
import {
  subscribeToLocalFileChanges,
} from "$lib/state/file-events";
import { undoStore } from "$lib/state/undo.svelte";

function entry(
  name: string,
  directory: string,
  options: { kind?: FileEntry["kind"]; modified?: string } = {},
): FileEntry {
  return {
    name,
    path: `${directory}/${name}`,
    kind: options.kind ?? "file",
    size: 1,
    modified: options.modified ?? "2026-01-01T00:00:00Z",
  };
}

function explorerAt(path: string, entries: FileEntry[]): ExplorerInstance {
  const explorer = createExplorerState({
    currentPath: path,
    entries,
    sortBy: "name",
    sortAscending: true,
    viewMode: "details",
  });
  explorers.push(explorer);
  return explorer;
}

function listing(entriesByPath: Record<string, FileEntry[]>): Load {
  return async (path) => {
    const entries = entriesByPath[path];
    return entries
      ? { ok: true, path, entries, streaming: false }
      : { ok: false, error: `No listing for ${path}` };
  };
}

let explorers: ExplorerInstance[] = [];

beforeEach(async () => {
  localStorage.clear();
  explorers = [];
  dialogStore.closeAll();
  await undoStore.clear();
  history.resetCalls();
  mocks.load.current = async () => ({ ok: false, error: "unset" });
  mocks.cleanup.mockClear();
  mocks.renameEntry.mockReset();
  mocks.deleteEntry.mockReset();
  mocks.deleteMultipleEntries.mockReset();
  mocks.deleteEntryPermanent.mockReset();
});

afterEach(async () => {
  dialogStore.closeAll();
  await undoStore.clear();
  await Promise.all(explorers.map((explorer) => explorer.destroy()));
  vi.restoreAllMocks();
});

describe("deferred rename dialog ownership", () => {
  it("does not close a newer rename for another entry", async () => {
    const first = entry("first.txt", "/A");
    const second = entry("second.txt", "/A");
    const renamed = entry("renamed.txt", "/A");
    const request = deferred<ApiResult<FileMutationReceipt>>();
    mocks.renameEntry.mockReturnValueOnce(request.promise);
    const explorer = explorerAt("/A", [first, second]);

    explorer.startRename(first);
    const pending = explorer.rename("renamed.txt");
    explorer.startRename(second);

    request.resolve({ ok: true, data: { path: renamed.path, entry: renamed } });
    expect(await pending).toBeNull();

    expect(dialogStore.isRenameOpen).toBe(true);
    expect(dialogStore.renamingEntry?.path).toBe(second.path);
    expect(history.port.push).toHaveBeenCalledWith({
      type: "rename",
      path: renamed.path,
      oldName: first.name,
      newName: renamed.name,
    }, false);
  });

  it("does not close a newer rename session when the same path is reopened", async () => {
    const original = entry("same.txt", "/A", { modified: "2026-01-01T00:00:00Z" });
    const reopened = entry("same.txt", "/A", { modified: "2026-02-01T00:00:00Z" });
    const renamed = entry("renamed.txt", "/A");
    const request = deferred<ApiResult<FileMutationReceipt>>();
    mocks.renameEntry.mockReturnValueOnce(request.promise);
    const explorer = explorerAt("/A", [original]);

    explorer.startRename(original);
    const pending = explorer.rename("renamed.txt");
    explorer.startRename(reopened);

    request.resolve({ ok: true, data: { path: renamed.path, entry: renamed } });
    expect(await pending).toBeNull();

    expect(dialogStore.isRenameOpen).toBe(true);
    expect(dialogStore.renamingEntry?.modified).toBe(reopened.modified);
    expect(history.port.push).toHaveBeenCalledWith({
      type: "rename",
      path: renamed.path,
      oldName: original.name,
      newName: renamed.name,
    }, false);
  });

  it("reconciles a committed rename without metadata and retains its selection identity", async () => {
    const original = entry("old.txt", "/A");
    const renamed = entry("renamed.txt", "/A");
    const request = deferred<ApiResult<FileMutationReceipt>>();
    mocks.renameEntry.mockReturnValueOnce(request.promise);
    mocks.load.current = listing({ "/A": [renamed] });
    const explorer = explorerAt("/A", [original]);
    const rekeyPath = vi.spyOn(clipboardStore, "rekeyPath");
    explorer.selectEntry(original);

    explorer.startRename(original);
    const pending = explorer.rename(renamed.name);
    request.resolve({ ok: true, data: { path: renamed.path, entry: null } });
    expect(await pending).toBeNull();

    await vi.waitFor(() => {
      expect(explorer.displayEntries.map(({ path }) => path)).toEqual([renamed.path]);
    });
    expect([...explorer.selectedPaths]).toEqual([renamed.path]);
    expect(explorer.focusedEntry?.path).toBe(renamed.path);
    expect(history.port.push).toHaveBeenCalledWith({
      type: "rename",
      path: renamed.path,
      oldName: original.name,
      newName: renamed.name,
    }, false);
    expect(rekeyPath).toHaveBeenCalledWith(original.path, renamed.path, null);
    expect(dialogStore.isRenameOpen).toBe(false);
  });
});

describe("deferred delete ownership", () => {
  it("keeps a newer directory and delete dialog while publishing delete and undo for the origin parent", async () => {
    const victim = entry("old.txt", "/A");
    const current = entry("current.txt", "/B");
    const secondVictim = entry("new-delete.txt", "/B");
    const request = deferred<ApiResult<void>>();
    mocks.deleteEntry.mockReturnValueOnce(request.promise);
    mocks.load.current = listing({ "/B": [current, secondVictim] });
    const explorer = explorerAt("/A", [victim]);
    const changes: string[][] = [];
    const unsubscribe = subscribeToLocalFileChanges((paths) => changes.push(paths));

    try {
      explorer.startDelete(victim);
      const pending = explorer.confirmDelete();

      expect(await explorer.navigateTo("/B")).toBe(true);
      explorer.startDelete(secondVictim);

      request.resolve({ ok: true, data: undefined });
      expect(await pending).toBeNull();

      expect(explorer.currentPath).toBe("/B");
      expect(explorer.displayEntries.map(({ path }) => path)).toEqual([
        current.path,
        secondVictim.path,
      ]);
      expect([...explorer.selectedPaths]).toEqual([current.path]);
      expect(dialogStore.isDeleteOpen).toBe(true);
      expect(dialogStore.deletingEntry?.path).toBe(secondVictim.path);
      expect(changes).toEqual([["/A"]]);
      const action: UndoAction = { type: "delete", paths: [victim.path], parentDir: "/A" };
      expect(history.port.push).toHaveBeenCalledWith(action, false);

      const expectedEntryId = history.currentUndoId();
      expect(expectedEntryId).not.toBeNull();
      history.queueExecution(action);
      changes.length = 0;
      expect(await explorer.undo()).toBeNull();
      expect(history.port.execute).toHaveBeenCalledWith("undo", expectedEntryId);
      expect(changes).toEqual([]);
      expect(explorer.currentPath).toBe("/B");
    } finally {
      unsubscribe();
    }
  });

  it("retains accepted effects after pane disposal without closing another pane's dialog", async () => {
    const victim = entry("old.txt", "/A");
    const other = entry("other.txt", "/B");
    const request = deferred<ApiResult<void>>();
    mocks.deleteEntry.mockReturnValueOnce(request.promise);
    mocks.load.current = listing({ "/B": [other] });
    const origin = explorerAt("/A", [victim]);
    const surviving = explorerAt("/B", [other]);
    const changes: string[][] = [];
    const unsubscribe = subscribeToLocalFileChanges((paths) => changes.push(paths));

    try {
      origin.startDelete(victim);
      const pending = origin.confirmDelete();
      await origin.destroy();

      surviving.startDelete(other);
      request.resolve({ ok: true, data: undefined });
      expect(await pending).toBeNull();

      expect(dialogStore.isDeleteOpen).toBe(true);
      expect(dialogStore.deletingEntry?.path).toBe(other.path);
      expect(changes).toEqual([["/A"]]);
      expect(undoStore.canUndo).toBe(true);
      const action: UndoAction = { type: "delete", paths: [victim.path], parentDir: "/A" };
      expect(history.port.push).toHaveBeenCalledWith(action, false);

      const expectedEntryId = history.currentUndoId();
      expect(expectedEntryId).not.toBeNull();
      history.queueExecution(action);
      changes.length = 0;
      expect(await surviving.undo()).toBeNull();
      expect(history.port.execute).toHaveBeenCalledWith("undo", expectedEntryId);
      expect(changes).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("does not let an explicit deletion borrow and close an already-active dialog", async () => {
    const dialogTarget = entry("dialog.txt", "/B");
    const externalTarget = entry("external.txt", "/Miller");
    const request = deferred<ApiResult<void>>();
    mocks.deleteEntry.mockReturnValueOnce(request.promise);
    const explorer = explorerAt("/B", [dialogTarget]);

    explorer.startDelete(dialogTarget);
    const pending = explorer.confirmDelete([externalTarget], false);

    request.resolve({ ok: true, data: undefined });
    expect(await pending).toBeNull();

    expect(dialogStore.isDeleteOpen).toBe(true);
    expect(dialogStore.deletingEntry?.path).toBe(dialogTarget.path);
  });

  it("publishes an explicit external Miller-column deletion and its undo to that entry's parent", async () => {
    const current = entry("current.txt", "/Active");
    const external = entry("external.txt", "/Miller");
    mocks.deleteEntry.mockResolvedValueOnce({ ok: true, data: undefined });
    mocks.load.current = listing({ "/Active": [current] });
    const explorer = explorerAt("/Active", [current]);
    const changes: string[][] = [];
    const unsubscribe = subscribeToLocalFileChanges((paths) => changes.push(paths));

    try {
      expect(await explorer.confirmDelete([external], false)).toBeNull();
      expect(explorer.displayEntries.map(({ path }) => path)).toEqual([current.path]);
      expect(changes).toEqual([["/Miller"]]);
      const action: UndoAction = {
        type: "delete",
        paths: [external.path],
        parentDir: "/Miller",
      };
      expect(history.port.push).toHaveBeenCalledWith(action, false);

      const expectedEntryId = history.currentUndoId();
      expect(expectedEntryId).not.toBeNull();
      history.queueExecution(action);
      changes.length = 0;
      expect(await explorer.undo()).toBeNull();
      expect(history.port.execute).toHaveBeenCalledWith("undo", expectedEntryId);
      expect(changes).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps distinct undo roots and notifications for a multi-parent deletion", async () => {
    const first = entry("first.txt", "/A");
    const second = entry("second.txt", "/B");
    const current = entry("current.txt", "/Active");
    mocks.deleteMultipleEntries.mockImplementationOnce(async (paths: string[]) => ({ ok: true, data: { succeeded: paths, failed: [] } }));
    mocks.load.current = listing({ "/Active": [current] });
    const explorer = explorerAt("/Active", [current]);
    const changes: string[][] = [];
    const unsubscribe = subscribeToLocalFileChanges((paths) => changes.push(paths));

    try {
      expect(await explorer.confirmDelete([first, second], false)).toBeNull();
      expect(mocks.deleteMultipleEntries).toHaveBeenCalledWith([first.path, second.path]);
      expect(changes).toEqual([["/A", "/B"]]);
      const action: UndoAction = {
        type: "batch",
        actions: [
          { type: "delete", paths: [first.path], parentDir: "/A" },
          { type: "delete", paths: [second.path], parentDir: "/B" },
        ],
        label: "Delete",
      };
      expect(history.port.push).toHaveBeenCalledWith(action, false);

      const expectedEntryId = history.currentUndoId();
      expect(expectedEntryId).not.toBeNull();
      history.queueExecution(action);
      changes.length = 0;
      expect(await explorer.undo()).toBeNull();
      expect(history.port.execute).toHaveBeenCalledWith("undo", expectedEntryId);
      expect(changes).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("publishes each successful permanent deletion even when another parent fails", async () => {
    const removed = entry("removed.txt", "/A");
    const retained = entry("retained.txt", "/B");
    mocks.deleteEntryPermanent
      .mockResolvedValueOnce({ ok: true, data: undefined })
      .mockResolvedValueOnce({ ok: false, error: "permission denied" });
    const explorer = explorerAt("/A", [removed]);
    const changes: string[][] = [];
    const unsubscribe = subscribeToLocalFileChanges((paths) => changes.push(paths));

    try {
      expect(await explorer.confirmDelete([removed, retained], true)).toBe("permission denied");
      expect(explorer.displayEntries).toEqual([]);
      expect(changes).toEqual([["/A"]]);
      expect(undoStore.canUndo).toBe(false);
      expect(history.port.push).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("still escapes a nested descendant of a directory deleted while the request is pending", async () => {
    const target = entry("gone", "/A", { kind: "directory" });
    const nested = `${target.path}/one/two`;
    const child = entry("child.txt", nested);
    const survivor = entry("survivor.txt", "/A");
    const request = deferred<ApiResult<void>>();
    mocks.deleteEntry.mockReturnValueOnce(request.promise);
    mocks.load.current = listing({
      [nested]: [child],
      "/A": [survivor],
    });
    const explorer = explorerAt("/A", [target, survivor]);

    explorer.startDelete(target);
    const pending = explorer.confirmDelete();
    expect(await explorer.navigateTo(nested)).toBe(true);

    request.resolve({ ok: true, data: undefined });
    expect(await pending).toBeNull();

    expect(explorer.currentPath).toBe("/A");
    expect(explorer.displayEntries.map(({ path }) => path)).toEqual([survivor.path]);
  });
});

describe("bulk trash receipts", () => {
  it("retains failed entries and records only successful paths for undo", async () => {
    const removed = entry("removed.txt", "/A");
    const failed = entry("denied.txt", "/B");
    mocks.deleteMultipleEntries.mockResolvedValueOnce({ ok: true, data: {
      succeeded: [removed.path], failed: [{ path: failed.path, error: "Permission denied" }],
    } });
    const explorer = explorerAt("/A", [removed]);
    const changes: string[][] = [];
    const unsubscribe = subscribeToLocalFileChanges((paths) => changes.push(paths));
    try {
      const error = await explorer.confirmDelete([removed, failed], false);
      expect(error).toContain("Permission denied");
      expect(explorer.displayEntries).toEqual([]);
      expect(changes).toEqual([["/A"]]);
      const action: UndoAction = {
        type: "delete",
        paths: [removed.path],
        parentDir: "/A",
      };
      expect(history.port.push).toHaveBeenCalledWith(action, false);
      const expectedEntryId = history.currentUndoId();
      expect(expectedEntryId).not.toBeNull();
      history.queueExecution(action);
      changes.length = 0;
      mocks.load.current = listing({ "/A": [removed] });
      expect(await explorer.undo()).toBeNull();
      expect(history.port.execute).toHaveBeenCalledWith("undo", expectedEntryId);
      expect(changes).toEqual([]);
      expect(explorer.displayEntries.map(({ path }) => path)).toEqual([removed.path]);
    } finally {
      unsubscribe();
    }
  });
});
