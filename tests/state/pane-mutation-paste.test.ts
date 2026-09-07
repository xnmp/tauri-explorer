import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { FileEntry } from "$lib/domain/file";
import type {
  DirectoryListingCallbacks,
  DirectoryListingResult,
  DirectoryObservation,
} from "$lib/state/directory-listing";
import type { UndoAction } from "$lib/state/types";

type Load = (
  path: string,
  callbacks: DirectoryListingCallbacks,
  observation?: DirectoryObservation,
) => Promise<DirectoryListingResult>;

const mocks = vi.hoisted(() => ({
  load: { current: (async () => ({ ok: false, error: "unset" })) as Load },
  cleanup: vi.fn(async () => {}),
  osReadFiles: vi.fn(),
  osWriteFiles: vi.fn(async () => ({ ok: true, data: null })),
  transfer: vi.fn(),
  estimateSize: vi.fn(async () => ({ ok: true, data: { totalBytes: 1 } })),
  cancelCopy: vi.fn(),
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
      callbacks: DirectoryListingCallbacks,
      observation?: DirectoryObservation,
    ) => mocks.load.current(path, callbacks, observation),
    cleanup: mocks.cleanup,
  }),
}));

vi.mock("$lib/api/os-clipboard", () => ({
  osClipboardHasFiles: vi.fn(async () => false),
  osClipboardReadFiles: mocks.osReadFiles,
  osClipboardWriteFiles: mocks.osWriteFiles,
}));

vi.mock("$lib/api/clipboard-image", () => ({
  clipboardHasImage: mocks.clipboardHasImage,
  clipboardPasteImage: mocks.clipboardPasteImage,
}));

vi.mock("$lib/state/file-transfer", () => ({
  performFileTransfer: mocks.transfer,
}));

vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/files")>()),
  estimateSize: mocks.estimateSize,
  cancelCopy: mocks.cancelCopy,
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
  mocks.load.current = async (path, _callbacks, observation) => {
    observation?.accept(null);
    return { ok: true, path, entries, streaming: false };
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

beforeEach(() => {
  clipboardStore.clear();
  vi.clearAllMocks();
  localStorage.clear();
  explorers = [];
  mocks.load.current = async () => ({ ok: false, error: "unset" });
  mocks.osReadFiles.mockResolvedValue({ ok: true, data: [] });
  mocks.clipboardHasImage.mockResolvedValue(false);
  mocks.undo.mockResolvedValue({ error: "Nothing to undo" });
  for (const operation of [...operationsManager.operations]) {
    operationsManager.clearOperation(operation.id);
  }
});

afterEach(async () => {
  await Promise.all(explorers.map((explorer) => explorer.destroy()));
  clipboardStore.clear();
});

describe("paste and undo publication ownership", () => {
  it("publishes and selects every file from a healthy same-pane batch paste", async () => {
    const explorer = explorerAtA();
    const sources = [entry("one.txt", "/source"), entry("two.txt", "/source")];
    const pasted = sources.map(({ name }) => entry(name));
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: sources.map(({ path }) => path) });
    mocks.transfer.mockImplementation(async (sourcePath: string, destination: string) => ({
      ok: true,
      entry: entry(sourcePath.split("/").pop()!, destination),
    }));
    serveListing([...explorer.displayEntries, ...pasted]);

    expect(await explorer.paste()).toBeNull();

    for (const created of pasted) {
      expect(explorer.displayEntries.filter(({ path }) => path === created.path)).toHaveLength(1);
    }
    expect(selectedPaths(explorer)).toEqual(pasted.map(({ path }) => path));
    expect(explorer.focusedEntry?.path).toBe(pasted[0].path);
    expect(mocks.broadcastFileChange).toHaveBeenCalledWith(expect.arrayContaining(["/a", "/source"]));
  });

  it("keeps the A destination captured while the OS clipboard read is pending", async () => {
    const explorer = explorerAtA();
    const source = entry("external.txt", "/source");
    const clipboardRead = deferred<ApiResult<string[]>>();
    mocks.osReadFiles.mockReturnValueOnce(clipboardRead.promise);
    mocks.transfer.mockImplementation(async (_path: string, destination: string) => ({
      ok: true,
      entry: entry(source.name, destination),
    }));

    const pending = explorer.paste();
    const bEntries = await navigateToB(explorer);
    clipboardRead.resolve({ ok: true, data: [source.path] });
    expect(await pending).toBeNull();

    expect.soft(mocks.transfer).toHaveBeenCalledWith(
      source.path,
      "/a",
      true,
      expect.any(Object),
    );
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(expect.arrayContaining(["/a", "/source"]));
  });

  it("does not publish a completed A transfer into a newer B view", async () => {
    const explorer = explorerAtA();
    const source = entry("external.txt", "/source");
    const transfer = deferred<{ ok: true; entry: FileEntry }>();
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [source.path] });
    mocks.transfer.mockReturnValueOnce(transfer.promise);

    const pending = explorer.paste();
    await waitForCall(mocks.transfer);
    expect(mocks.transfer.mock.calls[0][1]).toBe("/a");
    const bEntries = await navigateToB(explorer);
    transfer.resolve({ ok: true, entry: entry(source.name) });
    expect(await pending).toBeNull();

    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(expect.arrayContaining(["/a", "/source"]));
  });

  it("does not publish an A transfer after its pane is destroyed", async () => {
    const explorer = explorerAtA();
    const source = entry("external.txt", "/source");
    const transfer = deferred<{ ok: true; entry: FileEntry }>();
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [source.path] });
    mocks.transfer.mockReturnValueOnce(transfer.promise);
    const pending = explorer.paste();
    await waitForCall(mocks.transfer);
    const bEntries = await navigateToB(explorer);

    await explorer.destroy();
    explorers = explorers.filter((candidate) => candidate !== explorer);
    transfer.resolve({ ok: true, entry: entry(source.name) });
    expect(await pending).toBeNull();

    expect.soft(explorer.currentPath).toBe("/b");
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(expect.arrayContaining(["/a", "/source"]));
  });

  it("does not clear newer clipboard content when an older cut-paste completes", async () => {
    const explorer = explorerAtA();
    const oldCut = entry("old-cut.txt", "/source");
    const newerCopy = entry("newer-copy.txt", "/newer");
    await clipboardStore.cut([oldCut]);
    mocks.osReadFiles.mockResolvedValueOnce({ ok: true, data: [oldCut.path] });
    const transfer = deferred<{ ok: true; entry: FileEntry }>();
    mocks.transfer.mockReturnValueOnce(transfer.promise);

    const pending = explorer.paste();
    await waitForCall(mocks.transfer);
    await clipboardStore.copy([newerCopy]);
    transfer.resolve({ ok: true, entry: entry(oldCut.name) });
    expect(await pending).toBeNull();

    expect.soft(clipboardStore.content).toEqual({ entries: [newerCopy], operation: "copy" });
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(expect.arrayContaining(["/a", "/source"]));
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

  it("does not refresh or reselect B when an A undo finishes late", async () => {
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
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });
});
