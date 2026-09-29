import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import type { FileEntry } from "$lib/domain/file";
import type {
  DirectoryListingResult,
  DirectoryObservation,
} from "$lib/state/directory-listing";
import type { UndoAction } from "$lib/state/types";

type Load = (
  path: string,
  observation?: DirectoryObservation,
) => Promise<DirectoryListingResult>;

const mocks = vi.hoisted(() => ({
  load: { current: (async () => ({ ok: false, error: "unset" })) as Load },
  cleanup: vi.fn(async () => {}),
  osReadFiles: vi.fn(),
  osWriteFiles: vi.fn(async (_paths: string[]): Promise<{ ok: true; data: null } | { ok: false; error: string }> => ({ ok: true, data: null })),
  native: { revision: 0, entries: null as FileEntry[] | null, operation: null as "copy" | "cut" | null, paths: [] as string[], pending: Promise.resolve() as Promise<unknown> },
  transfer: vi.fn(),
  copyEntries: vi.fn(),
  moveEntries: vi.fn(),
  estimateSize: vi.fn(async () => ({ ok: true, data: { totalBytes: 1 } })),
  clipboardHasImage: vi.fn(),
  clipboardPasteImage: vi.fn(),
  broadcastFileChange: vi.fn(),
  undo: vi.fn(),
  undoPush: vi.fn(),
}));

vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: (
      path: string,
          observation?: DirectoryObservation,
    ) => mocks.load.current(path, observation),
    cleanup: mocks.cleanup,
  }),
}));

vi.mock("$lib/api/os-clipboard", () => ({
  osClipboardHasFiles: vi.fn(async () => false),
  osClipboardReadFiles: mocks.osReadFiles,
  osClipboardWriteFiles: mocks.osWriteFiles,
  osClipboardPublish: (entries: FileEntry[], operation: "copy" | "cut") => {
    const publish = mocks.native.pending.then(async () => {
    const written = await mocks.osWriteFiles(entries.map((entry) => entry.path));
    if (!written.ok) throw new Error(written.error);
    mocks.native.revision++;
    mocks.native.entries = entries;
    mocks.native.operation = operation;
    mocks.native.paths = entries.map((entry) => entry.path);
    return { ...mocks.native, mirrorError: null };
    });
    mocks.native.pending = publish.catch(() => {});
    return publish;
  },
  osClipboardSnapshot: async () => {
    await mocks.native.pending;
    const result = await mocks.osReadFiles();
    if (!result.ok) throw new Error(result.error);
    const paths: string[] = result.data;
    if (paths.length !== mocks.native.paths.length || paths.some((path, index) => path !== mocks.native.paths[index])) {
      mocks.native.revision++;
      mocks.native.entries = null;
      mocks.native.operation = null;
      mocks.native.paths = paths;
    }
    return { ...mocks.native, mirrorError: null };
  },
  osClipboardCompareAndClear: async (revision: number) => {
    if (revision !== mocks.native.revision || !mocks.native.entries) return false;
    mocks.native.revision++;
    mocks.native.entries = null;
    mocks.native.operation = null;
    return true;
  },
  osClipboardRekey: async (revision: number, oldPath: string, entry: FileEntry) => {
    if (revision !== mocks.native.revision || !mocks.native.entries) return null;
    const index = mocks.native.entries.findIndex((candidate) => candidate.path === oldPath);
    if (index < 0) return null;
    mocks.native.entries = mocks.native.entries.map((candidate, at) => at === index ? entry : candidate);
    mocks.native.paths = mocks.native.entries.map((candidate) => candidate.path);
    mocks.native.revision++;
    return { ...mocks.native, mirrorError: null };
  },
}));

vi.mock("$lib/api/clipboard-image", () => ({
  clipboardHasImage: mocks.clipboardHasImage,
  clipboardPasteImage: mocks.clipboardPasteImage,
}));

vi.mock("$lib/state/file-transfer", () => ({
  performFileTransfer: mocks.transfer,
}));

vi.mock("$lib/api/copy-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/copy-session")>()),
  copyEntries: mocks.copyEntries,
}));

vi.mock("$lib/api/move-session", () => ({
  moveEntries: mocks.moveEntries,
}));

vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/files")>()),
  estimateSize: mocks.estimateSize,
}));

vi.mock("$lib/state/file-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/state/file-events")>()),
  broadcastFileChange: mocks.broadcastFileChange,
}));

vi.mock("$lib/state/undo.svelte", () => ({
  undoStore: {
    push: mocks.undoPush,
    undo: mocks.undo,
    redo: vi.fn(async () => ({ error: "Nothing to redo" })),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
import { clipboardStore } from "$lib/state/clipboard.svelte";
import { operationsManager } from "$lib/state/operations.svelte";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function entry(name: string, dir = "/a"): FileEntry {
  return {
    name,
    path: `${dir}/${name}`,
    kind: "file",
    size: 1,
    modified: "2026-01-01T00:00:00Z",
  };
}

function transferSuccess(created: FileEntry) {
  return { ok: true as const, path: created.path, entry: created };
}

function copyOutcome(entries: (FileEntry | null)[], destination = "/a"): ApiResult<CopySessionOutcome> {
  return { ok: true, data: {
    items: entries.map((created, index) => ({
      status: "succeeded" as const,
      receipt: { path: created?.path ?? `${destination}/item-${index}.txt`, entry: created },
    })),
    cancelled: false,
    warnings: [],
  } };
}

function explorerAtA(): ExplorerInstance {
  const entries = [entry("a-first.txt"), entry("a-second.txt")];
  const explorer = createExplorerState({
    currentPath: "/a",
    entries,
    sortBy: "name",
    sortAscending: true,
    viewMode: "details",
  });
  explorer.selectEntry(entries[1]);
  explorers.push(explorer);
  return explorer;
}

function serveListing(entries: FileEntry[]): void {
  mocks.load.current = async (path, observation) => {
    observation?.accept(null);
    return { ok: true, path, entries };
  };
}

async function navigateToB(explorer: ExplorerInstance): Promise<FileEntry[]> {
  const entries = [entry("b-first.txt", "/b"), entry("b-newer.txt", "/b")];
  serveListing(entries);
  expect(await explorer.navigateTo("/b", { autoEnterSingleSubdir: false })).toBe(true);
  explorer.selectEntry(entries[1]);
  return entries;
}

function selectedPaths(explorer: ExplorerInstance): string[] {
  return explorer.getSelectedEntries().map(({ path }) => path);
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(mock).toHaveBeenCalled());
}

let explorers: ExplorerInstance[] = [];

beforeEach(async () => {
  mocks.native = { revision: mocks.native.revision + 1, entries: null, operation: null, paths: [], pending: Promise.resolve() };
  await clipboardStore.clear();
  vi.clearAllMocks();
  mocks.osReadFiles.mockReset();
  mocks.osWriteFiles.mockReset();
  mocks.osWriteFiles.mockResolvedValue({ ok: true, data: null });
  localStorage.clear();
  explorers = [];
  mocks.load.current = async () => ({ ok: false, error: "unset" });
  mocks.osReadFiles.mockImplementation(async () => ({ ok: true, data: [...mocks.native.paths] }));
  mocks.clipboardHasImage.mockResolvedValue(false);
  mocks.undo.mockResolvedValue({ error: "Nothing to undo" });
  mocks.copyEntries.mockImplementation(async (sources: readonly string[], destination: string, options: {
    onEvent?: (event: CopySessionEvent) => void;
  }) => {
    const created = sources.map((source) => entry(source.split("/").pop()!, destination));
    created.forEach((value, item) => options.onEvent?.({
      type: "completed", item, total: sources.length, entry: value,
    }));
    return copyOutcome(created, destination);
  });
  mocks.moveEntries.mockImplementation(mocks.copyEntries.getMockImplementation()!);
  for (const operation of [...operationsManager.operations]) {
    operationsManager.clearOperation(operation.id);
  }
});

afterEach(async () => {
  await Promise.all(explorers.map((explorer) => explorer.destroy()));
  await clipboardStore.clear();
});

describe("paste and undo publication ownership", () => {
  it("waits for the ordered native snapshot before pasting a pending Copy", async () => {
    const explorer = explorerAtA();
    const source = entry("pending.txt", "/source");
    let finishWrite!: () => void;
    mocks.osWriteFiles.mockImplementationOnce(() => new Promise((resolve) => {
      finishWrite = () => resolve({ ok: true, data: null });
    }));
    const copying = clipboardStore.copy([source]);
    const pasting = explorer.paste();

    await waitForCall(mocks.osWriteFiles);
    expect(mocks.copyEntries).not.toHaveBeenCalled();
    finishWrite();
    expect(await pasting).toBeNull();
    await copying;
    expect(mocks.copyEntries).toHaveBeenCalledWith([source.path], "/a", expect.anything());
  });

  it("waits for a Cut mirror before moving its source", async () => {
    const explorer = explorerAtA();
    const source = entry("pending-cut.txt", "/source");
    let finishWrite!: () => void;
    mocks.osWriteFiles.mockImplementationOnce(() => new Promise((resolve) => {
      finishWrite = () => resolve({ ok: true, data: null });
    }));
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [source.path] });
    const cutting = clipboardStore.cut([source]);
    const pasting = explorer.paste();

    await waitForCall(mocks.osWriteFiles);
    expect(mocks.moveEntries).not.toHaveBeenCalled();
    finishWrite();
    expect(await pasting).toBeNull();
    await cutting;
    expect(mocks.moveEntries).toHaveBeenCalledWith([source.path], "/a", expect.anything());
  });

  it("uses an external OS copy after the local mirror has settled", async () => {
    const explorer = explorerAtA();
    await clipboardStore.copy([entry("old.txt", "/source")]);
    const external = entry("external.txt", "/elsewhere");
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [external.path] });

    expect(await explorer.paste()).toBeNull();
    expect(mocks.copyEntries).toHaveBeenCalledWith([external.path], "/a", expect.anything());
  });

  it("copies an external selection with identical paths after native Cut ownership changes", async () => {
    const explorer = explorerAtA();
    const source = entry("same.txt", "/source");
    await clipboardStore.cut([source]);
    // The external owner can advertise the same files but has no private
    // token. A path comparison must never authorize a move.
    mocks.native.revision++;
    mocks.native.entries = null;
    mocks.native.operation = null;
    mocks.native.paths = [source.path];
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [source.path] });

    expect(await explorer.paste()).toBeNull();
    expect(mocks.copyEntries).toHaveBeenCalledWith([source.path], "/a", expect.anything());
    expect(mocks.moveEntries).not.toHaveBeenCalled();
  });

  it("does not move an old Cut after another app replaces it with an empty file clipboard", async () => {
    const explorer = explorerAtA();
    await clipboardStore.cut([entry("old-cut.txt", "/source")]);
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [] });

    expect(await explorer.paste()).toBe("Nothing in clipboard");
    expect(mocks.moveEntries).not.toHaveBeenCalled();
    expect(mocks.copyEntries).not.toHaveBeenCalled();
  });

  it("preserves a newer Cut operation when clipboard content changes during the OS read", async () => {
    const explorer = explorerAtA();
    await clipboardStore.copy([entry("old.txt", "/source")]);
    const osRead = deferred<{ ok: true; data: string[] }>();
    mocks.osReadFiles.mockReturnValueOnce(osRead.promise);

    const pasting = explorer.paste();
    await waitForCall(mocks.osReadFiles);
    const cut = entry("new.txt", "/source");
    await clipboardStore.cut([cut]);
    osRead.resolve({ ok: true, data: [cut.path] });

    expect(await pasting).toBeNull();
    expect(mocks.moveEntries).toHaveBeenCalledWith([cut.path], "/a", expect.anything());
    expect(mocks.copyEntries).not.toHaveBeenCalled();
  });

  it("publishes and selects every file from a healthy same-pane batch paste", async () => {
    const explorer = explorerAtA();
    const sources = [entry("one.txt", "/source"), entry("two.txt", "/source")];
    const pasted = sources.map(({ name }) => entry(name));
    const selectionSnapshots: string[][] = [];
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: sources.map(({ path }) => path) });
    mocks.copyEntries.mockImplementationOnce(async (_sources: readonly string[], _destination: string, options: {
      onEvent?: (event: CopySessionEvent) => void;
    }) => {
      pasted.forEach((created, item) => {
        options.onEvent?.({ type: "completed", item, total: pasted.length, entry: created });
        selectionSnapshots.push(selectedPaths(explorer));
      });
      return copyOutcome(pasted);
    });
    serveListing([...explorer.displayEntries, ...pasted]);

    expect(await explorer.paste()).toBeNull();

    for (const created of pasted) {
      expect(explorer.displayEntries.filter(({ path }) => path === created.path)).toHaveLength(1);
    }
    expect(selectionSnapshots).toEqual([[pasted[0].path], pasted.map(({ path }) => path)]);
    expect(selectedPaths(explorer)).toEqual(pasted.map(({ path }) => path));
    expect(explorer.focusedEntry?.path).toBe(pasted[0].path);
    expect(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it("keeps a newer user selection while later copy entries still arrive", async () => {
    const explorer = explorerAtA();
    const sources = [entry("one.txt", "/source"), entry("two.txt", "/source")];
    const pasted = sources.map(({ name }) => entry(name));
    const releaseSecond = deferred<void>();
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: sources.map(({ path }) => path) });
    mocks.copyEntries.mockImplementationOnce(async (_sources: readonly string[], _destination: string, options: {
      onEvent?: (event: CopySessionEvent) => void;
    }) => {
      options.onEvent?.({ type: "completed", item: 0, total: 2, entry: pasted[0] });
      await releaseSecond.promise;
      options.onEvent?.({ type: "completed", item: 1, total: 2, entry: pasted[1] });
      return copyOutcome(pasted);
    });
    serveListing([...explorer.displayEntries, ...pasted]);

    const pending = explorer.paste();
    await vi.waitFor(() => expect(selectedPaths(explorer)).toEqual([pasted[0].path]));
    explorer.selectEntry(explorer.displayEntries.find(({ path }) => path === "/a/a-first.txt")!);
    releaseSecond.resolve(undefined);
    expect(await pending).toBeNull();

    expect(explorer.displayEntries.filter(({ path }) => pasted.some((item) => item.path === path))).toHaveLength(2);
    expect(selectedPaths(explorer)).toEqual(["/a/a-first.txt"]);
    expect(explorer.focusedEntry?.path).toBe("/a/a-first.txt");
  });

  it("reconciles a committed paste without metadata while history remains native-owned", async () => {
    const explorer = explorerAtA();
    const previousSelection = selectedPaths(explorer);
    const source = entry("external.txt", "/source");
    const pasted = entry(source.name);
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [source.path] });
    mocks.copyEntries.mockResolvedValueOnce({ ok: true, data: {
      items: [{ status: "succeeded", receipt: { path: pasted.path, entry: null } }],
      cancelled: false, warnings: [],
    } });
    serveListing([...explorer.displayEntries, pasted]);

    expect(await explorer.paste()).toBeNull();

    expect(explorer.displayEntries.some(({ path }) => path === pasted.path)).toBe(true);
    expect(selectedPaths(explorer)).toEqual(previousSelection);
    expect(mocks.undoPush).not.toHaveBeenCalled();
    expect(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it("keeps the A destination captured while the OS clipboard read is pending", async () => {
    const explorer = explorerAtA();
    const source = entry("external.txt", "/source");
    const clipboardRead = deferred<ApiResult<string[]>>();
    mocks.osReadFiles.mockReturnValueOnce(clipboardRead.promise);
    const pending = explorer.paste();
    const bEntries = await navigateToB(explorer);
    clipboardRead.resolve({ ok: true, data: [source.path] });
    expect(await pending).toBeNull();

    expect.soft(mocks.copyEntries).toHaveBeenCalledWith(
      [source.path], "/a", expect.any(Object),
    );
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it("does not publish a completed A transfer into a newer B view", async () => {
    const explorer = explorerAtA();
    const source = entry("external.txt", "/source");
    const transfer = deferred<ApiResult<CopySessionOutcome>>();
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [source.path] });
    mocks.copyEntries.mockReturnValueOnce(transfer.promise);

    const pending = explorer.paste();
    await waitForCall(mocks.copyEntries);
    expect(mocks.copyEntries.mock.calls[0][1]).toBe("/a");
    const bEntries = await navigateToB(explorer);
    transfer.resolve(copyOutcome([entry(source.name)]));
    expect(await pending).toBeNull();

    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it("does not publish an A transfer after its pane is destroyed", async () => {
    const explorer = explorerAtA();
    const source = entry("external.txt", "/source");
    const transfer = deferred<ApiResult<CopySessionOutcome>>();
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [source.path] });
    mocks.copyEntries.mockReturnValueOnce(transfer.promise);
    const pending = explorer.paste();
    await waitForCall(mocks.copyEntries);
    const bEntries = await navigateToB(explorer);

    await explorer.destroy();
    explorers = explorers.filter((candidate) => candidate !== explorer);
    transfer.resolve(copyOutcome([entry(source.name)]));
    expect(await pending).toBeNull();

    expect.soft(explorer.currentPath).toBe("/b");
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it("does not clear newer clipboard content when an older cut-paste completes", async () => {
    const explorer = explorerAtA();
    const oldCut = entry("old-cut.txt", "/source");
    const newerCopy = entry("newer-copy.txt", "/newer");
    await clipboardStore.cut([oldCut]);
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [oldCut.path] });
    const session = deferred<ApiResult<CopySessionOutcome>>();
    mocks.moveEntries.mockReturnValueOnce(session.promise);

    const pending = explorer.paste();
    await waitForCall(mocks.moveEntries);
    await clipboardStore.copy([newerCopy]);
    session.resolve(copyOutcome([entry(oldCut.name)]));
    expect(await pending).toBeNull();

    expect.soft(clipboardStore.content).toEqual({ entries: [newerCopy], operation: "copy" });
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(expect.arrayContaining(["/a", "/source"]));
  });

  it("keeps the cut clipboard and reconciles the destination after incomplete source cleanup", async () => {
    const explorer = explorerAtA();
    const cut = entry("partial.txt", "/source");
    const destination = entry(cut.name);
    await clipboardStore.cut([cut]);
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [cut.path] });
    // Native reports an incomplete relocation as an uncertain item, never as
    // a success: the destination exists but the source may still be there.
    mocks.moveEntries.mockResolvedValueOnce({ ok: true, data: {
      items: [{ status: "uncertain" as const, error: "source cleanup denied" }],
      cancelled: false,
      warnings: [],
    } });
    serveListing([...explorer.displayEntries, destination]);

    const error = await explorer.paste();

    expect(error).toContain("source cleanup denied");
    expect(clipboardStore.content).toEqual({ entries: [cut], operation: "cut" });
    expect(explorer.displayEntries.some(({ path }) => path === destination.path)).toBe(true);
    expect(mocks.undoPush).not.toHaveBeenCalled();
  });

  it("keeps clipboard-image destination and completion scoped to A", async () => {
    const explorer = explorerAtA();
    const imageAvailable = deferred<boolean>();
    const imagePaste = deferred<ApiResult<string>>();
    mocks.clipboardHasImage.mockReturnValueOnce(imageAvailable.promise);
    mocks.clipboardPasteImage.mockReturnValueOnce(imagePaste.promise);

    const pending = explorer.paste();
    const bEntries = await navigateToB(explorer);
    imageAvailable.resolve(true);
    await waitForCall(mocks.clipboardPasteImage);
    expect.soft(mocks.clipboardPasteImage).toHaveBeenCalledWith("/a");
    imagePaste.resolve({ ok: true, data: "/a/Pasted Image.png" });
    expect(await pending).toBeNull();

    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
  });

  it("does not refresh, reselect, or duplicate-publish when an A undo finishes late", async () => {
    const explorer = explorerAtA();
    const undone = deferred<{ action: UndoAction }>();
    mocks.undo.mockReturnValueOnce(undone.promise);

    const pending = explorer.undo();
    const bEntries = await navigateToB(explorer);
    const action: UndoAction = { type: "copy", copiedPath: "/a/copied.txt", parentDir: "/a" };
    undone.resolve({ action });
    expect(await pending).toBeNull();

    expect.soft(explorer.currentPath).toBe("/b");
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).not.toHaveBeenCalled();
  });

  it.each([false, true])("refreshes a current pane for a partial undo without duplicate publication (navigate away: %s)", async (navigateAway) => {
    const explorer = explorerAtA();
    const undone = deferred<{ action: UndoAction; error: string }>();
    mocks.undo.mockReturnValueOnce(undone.promise);
    const pending = explorer.undo();
    const expected = navigateAway
      ? await navigateToB(explorer)
      : [...explorer.displayEntries, entry("restored.txt")];
    if (!navigateAway) serveListing(expected);
    undone.resolve({
      action: { type: "delete", paths: ["/a/restored.txt"], parentDir: "/a" },
      error: "/elsewhere/blocked.txt: permission denied",
    });

    expect(await pending).toContain("permission denied");
    expect(mocks.broadcastFileChange).not.toHaveBeenCalled();
    expect(explorer.displayEntries.map(({ path }) => path).sort()).toEqual(expected.map(({ path }) => path).sort());
    expect(selectedPaths(explorer)).toEqual([navigateAway ? "/b/b-newer.txt" : "/a/a-second.txt"]);
  });
});
