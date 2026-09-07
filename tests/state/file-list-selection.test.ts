import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type {
  DirectoryListingCallbacks,
  DirectoryListingResult,
} from "$lib/state/directory-listing";

type Load = (
  path: string,
  callbacks: DirectoryListingCallbacks,
) => Promise<DirectoryListingResult>;

const mocks = vi.hoisted(() => ({
  load: { current: (async () => ({ ok: false, error: "unset" })) as Load },
  cleanup: vi.fn(async () => {}),
  createDirectory: vi.fn(),
  createEmptyFile: vi.fn(),
  renameEntry: vi.fn(),
}));

vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: (path: string, callbacks: DirectoryListingCallbacks) =>
      mocks.load.current(path, callbacks),
    cleanup: mocks.cleanup,
  }),
}));

vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/files")>()),
  createDirectory: mocks.createDirectory,
  createEmptyFile: mocks.createEmptyFile,
  renameEntry: mocks.renameEntry,
}));

import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
import { calculateSelection } from "$lib/state/selection";

function entry(
  name: string,
  options: { dir?: string; kind?: FileEntry["kind"]; modified?: string } = {},
): FileEntry {
  const dir = options.dir ?? "/root";
  return {
    name,
    path: `${dir}/${name}`,
    kind: options.kind ?? "file",
    size: 1,
    modified: options.modified ?? "2026-01-01T00:00:00Z",
  };
}

function explorerWith(entries: FileEntry[]): ExplorerInstance {
  const explorer = createExplorerState({
    currentPath: "/root",
    entries,
    sortBy: "name",
    sortAscending: true,
    viewMode: "details",
  });
  explorers.push(explorer);
  return explorer;
}

function selectedNames(explorer: ExplorerInstance): string[] {
  return explorer.getSelectedEntries().map(({ name }) => name);
}

let explorers: ExplorerInstance[] = [];

beforeEach(() => {
  localStorage.clear();
  explorers = [];
  mocks.cleanup.mockClear();
  mocks.createDirectory.mockReset();
  mocks.createEmptyFile.mockReset();
  mocks.renameEntry.mockReset();
  mocks.load.current = async () => ({ ok: false, error: "unset" });
});

afterEach(async () => {
  await Promise.all(explorers.map((explorer) => explorer.destroy()));
});

describe("path-based range selection", () => {
  it("keeps the same anchor through reordering and insertion, then resets if it disappears", () => {
    const [a, b, c] = [entry("a"), entry("b"), entry("c")];
    const initial = calculateSelection([a, b, c], b, new Set(), null, {});

    const reordered = calculateSelection(
      [c, b, a],
      a,
      initial.selectedPaths,
      initial.anchorPath,
      { shiftKey: true },
    );
    expect([...reordered.selectedPaths]).toEqual([b.path, a.path]);

    const inserted = entry("inserted");
    const afterInsertion = calculateSelection(
      [c, inserted, b, a],
      c,
      reordered.selectedPaths,
      reordered.anchorPath,
      { shiftKey: true },
    );
    expect([...afterInsertion.selectedPaths]).toEqual([c.path, inserted.path, b.path]);

    const afterAnchorRemoval = calculateSelection(
      [c, inserted, a],
      a,
      afterInsertion.selectedPaths,
      afterInsertion.anchorPath,
      { shiftKey: true },
    );
    expect([...afterAnchorRemoval.selectedPaths]).toEqual([a.path]);

    const nextRange = calculateSelection(
      [c, inserted, a],
      inserted,
      afterAnchorRemoval.selectedPaths,
      afterAnchorRemoval.anchorPath,
      { shiftKey: true },
    );
    expect([...nextRange.selectedPaths]).toEqual([inserted.path, a.path]);
  });
});

describe("explorer selection and focus cursor", () => {
  it("extends repeated Shift selection from the original anchor while focusing the endpoint", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const explorer = explorerWith(entries);

    explorer.selectEntry(entries[0]);
    explorer.selectEntry(entries[1], { shiftKey: true });
    explorer.selectEntry(entries[2], { shiftKey: true });

    expect(selectedNames(explorer)).toEqual(["a", "b", "c"]);
    expect(explorer.focusedEntry?.path).toBe(entries[2].path);
  });

  it("keeps focus on a Ctrl-clicked row after toggling it out of a multi-selection", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const explorer = explorerWith(entries);

    explorer.selectEntry(entries[0]);
    explorer.selectEntry(entries[2], { ctrlKey: true });
    expect(selectedNames(explorer)).toEqual(["a", "c"]);

    explorer.selectEntry(entries[2], { ctrlKey: true });

    expect(selectedNames(explorer)).toEqual(["a"]);
    expect(explorer.focusedEntry?.path).toBe(entries[2].path);
  });

  it("moves the cursor without changing an existing multi-selection", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const explorer = explorerWith(entries);
    explorer.selectEntry(entries[0]);
    explorer.selectEntry(entries[2], { ctrlKey: true });

    explorer.focusEntry(entries[1]);

    expect(selectedNames(explorer)).toEqual(["a", "c"]);
    expect(explorer.focusedEntry?.path).toBe(entries[1].path);
  });

  it("selects all entries without moving the existing cursor", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const explorer = explorerWith(entries);
    explorer.focusEntry(entries[2]);

    explorer.selectAll();

    expect(selectedNames(explorer)).toEqual(["a", "b", "c"]);
    expect(explorer.focusedEntry?.path).toBe(entries[2].path);
  });

  it("preserves the cursor when background clearing empties the selection", () => {
    const entries = [entry("a"), entry("b")];
    const explorer = explorerWith(entries);
    explorer.selectEntry(entries[1]);

    explorer.clearSelection();

    expect(explorer.selectedPaths.size).toBe(0);
    expect(explorer.focusedEntry?.path).toBe(entries[1].path);
  });

  it("selects, anchors, and focuses each successfully created entry", async () => {
    const a = entry("a");
    const c = entry("c");
    const explorer = explorerWith([a, c]);
    const folder = entry("b", { kind: "directory" });
    const file = entry("d");
    mocks.createDirectory.mockResolvedValueOnce({ ok: true, data: folder });
    mocks.createEmptyFile.mockResolvedValueOnce({ ok: true, data: file });

    expect(await explorer.createFolder("b")).toBeNull();
    expect(selectedNames(explorer)).toEqual(["b"]);
    expect(explorer.focusedEntry?.path).toBe(folder.path);
    explorer.selectEntry(c, { shiftKey: true });
    // Directories sort before files, so the range from b/ through c includes a.
    expect(selectedNames(explorer)).toEqual(["b", "a", "c"]);

    expect(await explorer.createFile("d")).toBeNull();
    expect(selectedNames(explorer)).toEqual(["d"]);
    expect(explorer.focusedEntry?.path).toBe(file.path);
    explorer.selectEntry(c, { shiftKey: true });
    expect(selectedNames(explorer)).toEqual(["c", "d"]);
  });

  it("remaps selection, cursor, and range anchor when a selected entry is renamed", async () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const explorer = explorerWith(entries);
    explorer.selectEntry(entries[0]);
    explorer.selectEntry(entries[1], { ctrlKey: true });
    const renamed = entry("bb");
    mocks.renameEntry.mockResolvedValueOnce({ ok: true, data: renamed });
    explorer.startRename(entries[1]);

    expect(await explorer.rename("bb")).toBeNull();

    expect(selectedNames(explorer)).toEqual(["a", "bb"]);
    expect(explorer.focusedEntry?.path).toBe(renamed.path);

    explorer.selectEntry(entries[2], { shiftKey: true });
    expect(selectedNames(explorer)).toEqual(["bb", "c"]);
    expect(explorer.focusedEntry?.path).toBe(entries[2].path);
  });

  it("does not replace newer selection or cursor when an earlier rename completes", async () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const explorer = explorerWith(entries);
    explorer.selectEntry(entries[0]);
    explorer.selectEntry(entries[1], { ctrlKey: true });
    const renamed = entry("bb");
    let finishRename!: () => void;
    mocks.renameEntry.mockImplementationOnce(() => new Promise((resolve) => {
      finishRename = () => resolve({ ok: true, data: renamed });
    }));
    explorer.startRename(entries[1]);

    const pending = explorer.rename("bb");
    explorer.selectEntry(entries[2]);
    finishRename();
    expect(await pending).toBeNull();

    expect(selectedNames(explorer)).toEqual(["c"]);
    expect(explorer.focusedEntry?.path).toBe(entries[2].path);
    explorer.selectEntry(entries[0], { shiftKey: true });
    expect(selectedNames(explorer)).toEqual(["a", "bb", "c"]);
  });

  it("moves selection and focus to the first filter match", () => {
    const entries = [entry("alpha"), entry("beta"), entry("bravo")];
    const explorer = explorerWith(entries);
    explorer.selectEntry(entries[0]);

    explorer.setFilter("br");

    expect(explorer.displayEntries.map(({ name }) => name)).toEqual(["bravo"]);
    expect(selectedNames(explorer)).toEqual(["bravo"]);
    expect(explorer.focusedEntry?.name).toBe("bravo");
  });

  it("resets selection and focus to the first entry after navigation", async () => {
    const explorer = explorerWith([entry("old-a"), entry("old-b")]);
    explorer.selectEntry(explorer.displayEntries[1]);
    const next = [entry("next-a", { dir: "/next" }), entry("next-b", { dir: "/next" })];
    mocks.load.current = async (path) => ({
      ok: true,
      path,
      entries: next,
      streaming: false,
    });

    expect(await explorer.navigateTo("/next")).toBe(true);

    expect(selectedNames(explorer)).toEqual(["next-a"]);
    expect(explorer.focusedEntry?.path).toBe(next[0].path);
  });
});
