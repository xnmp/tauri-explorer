import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { FileEntry, FileMutationReceipt } from "$lib/domain/file";
import type {
  DirectoryListingCallbacks,
  DirectoryListingResult,
  DirectoryObservation,
} from "$lib/state/directory-listing";

type Load = (
  path: string,
  callbacks: DirectoryListingCallbacks,
  observation?: DirectoryObservation,
) => Promise<DirectoryListingResult>;

const mocks = vi.hoisted(() => ({
  load: { current: (async () => ({ ok: false, error: "unset" })) as Load },
  cleanup: vi.fn(async () => {}),
  createDirectory: vi.fn(),
  createEmptyFile: vi.fn(),
  createSymlink: vi.fn(),
  broadcastFileChange: vi.fn(),
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

vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/files")>()),
  createDirectory: mocks.createDirectory,
  createEmptyFile: mocks.createEmptyFile,
  createSymlink: mocks.createSymlink,
}));

vi.mock("$lib/state/file-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/state/file-events")>()),
  broadcastFileChange: mocks.broadcastFileChange,
}));

import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function entry(
  name: string,
  options: { dir?: string; kind?: FileEntry["kind"] } = {},
): FileEntry {
  const dir = options.dir ?? "/a";
  return {
    name,
    path: `${dir}/${name}`,
    kind: options.kind ?? "file",
    size: 1,
    modified: "2026-01-01T00:00:00Z",
  };
}

const mutationKinds = ["folder", "file", "symlink"] as const;
type MutationKind = (typeof mutationKinds)[number];

function beginMutation(explorer: ExplorerInstance, kind: MutationKind) {
  const completion = deferred<ApiResult<FileMutationReceipt>>();
  if (kind === "folder") {
    const created = entry("created-folder", { kind: "directory" });
    mocks.createDirectory.mockReturnValueOnce(completion.promise);
    return {
      completion,
      created,
      pending: explorer.createFolder(created.name),
      expectedCall: ["/a", created.name],
      api: mocks.createDirectory,
    };
  }
  if (kind === "file") {
    const created = entry("created-file.txt");
    mocks.createEmptyFile.mockReturnValueOnce(completion.promise);
    return {
      completion,
      created,
      pending: explorer.createFile(created.name),
      expectedCall: ["/a", created.name],
      api: mocks.createEmptyFile,
    };
  }
  const source = "/a/source.txt";
  const created = entry("source.txt - Link");
  mocks.createSymlink.mockReturnValueOnce(completion.promise);
  return {
    completion,
    created,
    pending: explorer.createSymlink(source),
    expectedCall: [source, created.path],
    api: mocks.createSymlink,
  };
}

function explorerAtA(): ExplorerInstance {
  const entries = [entry("old-a.txt"), entry("old-b.txt")];
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

function selectedPaths(explorer: ExplorerInstance): string[] {
  return explorer.getSelectedEntries().map(({ path }) => path);
}

function serveListing(entries: FileEntry[]): void {
  mocks.load.current = async (path, _callbacks, observation) => {
    await observation?.ready;
    observation?.accept(null);
    return { ok: true, path, entries, streaming: false };
  };
}

async function navigateToB(explorer: ExplorerInstance): Promise<FileEntry[]> {
  const entries = [entry("b-first.txt", { dir: "/b" }), entry("b-newer.txt", { dir: "/b" })];
  serveListing(entries);
  expect(await explorer.navigateTo("/b", { autoEnterSingleSubdir: false })).toBe(true);
  explorer.selectEntry(entries[1]);
  return entries;
}

let explorers: ExplorerInstance[] = [];

beforeEach(() => {
  localStorage.clear();
  explorers = [];
  mocks.load.current = async () => ({ ok: false, error: "unset" });
  mocks.cleanup.mockClear();
  mocks.createDirectory.mockReset();
  mocks.createEmptyFile.mockReset();
  mocks.createSymlink.mockReset();
  mocks.broadcastFileChange.mockReset();
});

afterEach(async () => {
  await Promise.all(explorers.map((explorer) => explorer.destroy()));
});

describe("pane mutation publication ownership", () => {
  it.each(mutationKinds)("keeps a newer B view intact when an A %s completes", async (kind) => {
    const explorer = explorerAtA();
    const mutation = beginMutation(explorer, kind);
    expect(mutation.api).toHaveBeenCalledWith(...mutation.expectedCall);
    const bEntries = await navigateToB(explorer);

    mutation.completion.resolve({ ok: true, data: { path: mutation.created.path, entry: mutation.created } });
    await mutation.pending;

    expect.soft(explorer.currentPath).toBe("/b");
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledOnce();
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it.each(mutationKinds)("does not publish pane state after its pending A %s owner is destroyed", async (kind) => {
    const explorer = explorerAtA();
    const originalPaths = explorer.displayEntries.map(({ path }) => path);
    const originalSelection = selectedPaths(explorer);
    const originalCursor = explorer.focusedEntry?.path;
    const mutation = beginMutation(explorer, kind);

    await explorer.destroy();
    explorers = explorers.filter((candidate) => candidate !== explorer);
    mutation.completion.resolve({ ok: true, data: { path: mutation.created.path, entry: mutation.created } });
    await mutation.pending;

    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(originalPaths);
    expect.soft(selectedPaths(explorer)).toEqual(originalSelection);
    expect.soft(explorer.focusedEntry?.path).toBe(originalCursor);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledOnce();
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it("does not close a newer B inline editor when an older A create completes", async () => {
    const explorer = explorerAtA();
    explorer.startInlineNewFolder();
    const mutation = beginMutation(explorer, "folder");
    const bEntries = await navigateToB(explorer);
    explorer.startInlineNewFile();

    mutation.completion.resolve({ ok: true, data: { path: mutation.created.path, entry: mutation.created } });
    await mutation.pending;

    expect.soft(explorer.currentPath).toBe("/b");
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(bEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([bEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(bEntries[1].path);
    expect.soft(explorer.isCreatingFolder).toBe(true);
    expect.soft(explorer.newEntryKind).toBe("file");
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it.each(mutationKinds)("rejects stale A %s publication after navigating A to B and back to A", async (kind) => {
    const explorer = explorerAtA();
    const mutation = beginMutation(explorer, kind);
    await navigateToB(explorer);
    const newerAEntries = [entry("returned-a.txt"), entry("returned-b.txt")];
    serveListing(newerAEntries);
    expect(await explorer.navigateTo("/a", { autoEnterSingleSubdir: false })).toBe(true);
    explorer.selectEntry(newerAEntries[1]);

    mutation.completion.resolve({ ok: true, data: { path: mutation.created.path, entry: mutation.created } });
    await mutation.pending;

    expect.soft(explorer.currentPath).toBe("/a");
    expect.soft(explorer.displayEntries.map(({ path }) => path)).toEqual(newerAEntries.map(({ path }) => path));
    expect.soft(selectedPaths(explorer)).toEqual([newerAEntries[1].path]);
    expect.soft(explorer.focusedEntry?.path).toBe(newerAEntries[1].path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledOnce();
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it.each(mutationKinds)("does not duplicate an A %s already published by a listing refresh", async (kind) => {
    const explorer = explorerAtA();
    const mutation = beginMutation(explorer, kind);
    const refreshedEntries = [...explorer.displayEntries, mutation.created];
    serveListing(refreshedEntries);

    await explorer.refresh({ silent: true });
    expect(explorer.displayEntries.filter(({ path }) => path === mutation.created.path)).toHaveLength(1);

    mutation.completion.resolve({ ok: true, data: { path: mutation.created.path, entry: mutation.created } });
    await mutation.pending;

    expect.soft(explorer.displayEntries.filter(({ path }) => path === mutation.created.path)).toHaveLength(1);
    if (kind !== "symlink") {
      expect.soft(selectedPaths(explorer)).toEqual([mutation.created.path]);
      expect.soft(explorer.focusedEntry?.path).toBe(mutation.created.path);
    }
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledOnce();
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it.each(["folder", "file"] as const)("preserves newer same-pane selection when an A %s completes", async (kind) => {
    const explorer = explorerAtA();
    const mutation = beginMutation(explorer, kind);
    const newerSelection = explorer.displayEntries[0];
    explorer.selectEntry(newerSelection);

    mutation.completion.resolve({ ok: true, data: { path: mutation.created.path, entry: mutation.created } });
    await mutation.pending;

    expect.soft(explorer.displayEntries.filter(({ path }) => path === mutation.created.path)).toHaveLength(1);
    // A selection made after the request is newer user intent than the
    // operation's usual select-created convenience behavior.
    expect.soft(selectedPaths(explorer)).toEqual([newerSelection.path]);
    expect.soft(explorer.focusedEntry?.path).toBe(newerSelection.path);
    expect.soft(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });

  it("reconciles a committed create whose receipt has no entry metadata", async () => {
    const explorer = explorerAtA();
    const mutation = beginMutation(explorer, "folder");
    serveListing([...explorer.displayEntries, mutation.created]);

    mutation.completion.resolve({
      ok: true,
      data: { path: mutation.created.path, entry: null },
    });
    expect(await mutation.pending).toBeNull();

    await vi.waitFor(() => {
      expect(explorer.displayEntries.some(({ path }) => path === mutation.created.path)).toBe(true);
    });
    expect(selectedPaths(explorer)).toEqual([mutation.created.path]);
    expect(explorer.focusedEntry?.path).toBe(mutation.created.path);
    expect(mocks.broadcastFileChange).toHaveBeenCalledWith(["/a"]);
  });
});
