/**
 * Tests for performFileTransfer: the shared move/copy logic
 * used by both drag-drop and paste operations.
 * Issue: #107
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry } from "$lib/domain/file";

// --- Mocks for all dependencies ---

const moveEntryMock = vi.fn();
const copyEntryMock = vi.fn();
const fetchDirectoryMock = vi.fn();

vi.mock("$lib/api/files", () => ({
  moveEntry: (...args: unknown[]) => moveEntryMock(...args),
  copyEntry: (...args: unknown[]) => copyEntryMock(...args),
  fetchDirectory: (...args: unknown[]) => fetchDirectoryMock(...args),
}));

const conflictPromptMock = vi.fn();
vi.mock("$lib/state/conflict-resolver.svelte", () => ({
  conflictResolver: {
    prompt: (...args: unknown[]) => conflictPromptMock(...args),
  },
}));

const undoPushMock = vi.fn();
vi.mock("$lib/state/undo.svelte", () => ({
  undoStore: {
    push: (...args: unknown[]) => undoPushMock(...args),
  },
}));

const toastShowMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("$lib/state/toast.svelte", () => ({
  toastStore: {
    show: (...args: unknown[]) => toastShowMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const broadcastMock = vi.fn();
vi.mock("$lib/state/file-events", () => ({
  broadcastFileChange: (...args: unknown[]) => broadcastMock(...args),
}));

const pruneMock = vi.fn();
vi.mock("$lib/state/frecency.svelte", () => ({
  frecencyStore: {
    pruneNonExistent: () => pruneMock(),
  },
}));

import { performFileTransfer } from "$lib/state/file-transfer";

function makeEntry(name: string, path: string): FileEntry {
  return { name, path, kind: "file", size: 100, modified: "2026-01-01T00:00:00Z" };
}

const resultEntry = makeEntry("file.txt", "/dest/file.txt");
const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  moveEntryMock.mockResolvedValue({ ok: true, data: resultEntry });
  copyEntryMock.mockResolvedValue({ ok: true, data: resultEntry });
  fetchDirectoryMock.mockResolvedValue({ ok: true, data: { entries: [] } });
});

describe("performFileTransfer", () => {
  // --- Basic move/copy dispatch ---

  it("moves a file when isCopy is false", async () => {
    const refreshMock = vi.fn();
    const result = await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: refreshMock,
    });

    expect(result.ok).toBe(true);
    expect(result.entry).toEqual(resultEntry);
    expect(moveEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", false);
    expect(copyEntryMock).not.toHaveBeenCalled();
  });

  it("copies a file when isCopy is true", async () => {
    const result = await performFileTransfer("/src/file.txt", "/dest", true, {
      onRefresh: noop,
    });

    expect(result.ok).toBe(true);
    expect(copyEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", false, undefined);
    expect(moveEntryMock).not.toHaveBeenCalled();
  });

  // --- Error handling ---

  it("returns error when move fails", async () => {
    moveEntryMock.mockResolvedValue({ ok: false, error: "permission denied" });

    const result = await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("permission denied");
  });

  it("shows toast on failure by default", async () => {
    moveEntryMock.mockResolvedValue({ ok: false, error: "disk full" });

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(toastErrorMock).toHaveBeenCalledWith("disk full");
  });

  it("suppresses toast on failure when suppressToast is set", async () => {
    moveEntryMock.mockResolvedValue({ ok: false, error: "disk full" });

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      suppressToast: true,
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  // --- Conflict detection via fetch ---

  it("detects conflict by fetching target directory", async () => {
    const existing = makeEntry("file.txt", "/dest/file.txt");
    fetchDirectoryMock.mockResolvedValue({
      ok: true,
      data: { entries: [existing] },
    });
    conflictPromptMock.mockResolvedValue({ choice: "overwrite", applyToAll: false });

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(conflictPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "file.txt", sourcePath: "/src/file.txt" }),
    );
    expect(moveEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", true);
  });

  it("skips transfer when user chooses skip on conflict", async () => {
    fetchDirectoryMock.mockResolvedValue({
      ok: true,
      data: { entries: [makeEntry("file.txt", "/dest/file.txt")] },
    });
    conflictPromptMock.mockResolvedValue({ choice: "skip", applyToAll: false });

    const result = await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("skipped");
    expect(moveEntryMock).not.toHaveBeenCalled();
  });

  it("cancels transfer when user chooses cancel on conflict", async () => {
    fetchDirectoryMock.mockResolvedValue({
      ok: true,
      data: { entries: [makeEntry("file.txt", "/dest/file.txt")] },
    });
    conflictPromptMock.mockResolvedValue({ choice: "cancel", applyToAll: false });

    const result = await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("skipped");
    expect(moveEntryMock).not.toHaveBeenCalled();
  });

  // --- Conflict detection via existingEntries ---

  it("uses existingEntries for conflict check when provided", async () => {
    const existing = makeEntry("file.txt", "/dest/file.txt");
    conflictPromptMock.mockResolvedValue({ choice: "overwrite", applyToAll: false });

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      existingEntries: [existing],
    });

    // Should not fetch directory when existingEntries is provided
    expect(fetchDirectoryMock).not.toHaveBeenCalled();
    expect(conflictPromptMock).toHaveBeenCalled();
    expect(moveEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", true);
  });

  it("skips conflict check when no name match in existingEntries", async () => {
    const other = makeEntry("other.txt", "/dest/other.txt");

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      existingEntries: [other],
    });

    expect(conflictPromptMock).not.toHaveBeenCalled();
    expect(moveEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", false);
  });

  // --- skipConflictCheck ---

  it("skips conflict detection entirely when skipConflictCheck is true", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      skipConflictCheck: true,
    });

    expect(fetchDirectoryMock).not.toHaveBeenCalled();
    expect(conflictPromptMock).not.toHaveBeenCalled();
    expect(moveEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", false);
  });

  // --- overwrite flag ---

  it("passes overwrite through and skips conflict check when overwrite is true", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      overwrite: true,
    });

    expect(conflictPromptMock).not.toHaveBeenCalled();
    expect(moveEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", true);
  });

  // --- Side effects: undo, toast, broadcast, refresh ---

  it("records undo for move operations", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(undoPushMock).toHaveBeenCalledWith({
      type: "move",
      sourcePath: "/src/file.txt",
      destPath: "/dest/file.txt",
      originalDir: "/src",
    });
  });

  it("records undo for copy operations (mirrors paste)", async () => {
    await performFileTransfer("/src/file.txt", "/dest", true, {
      onRefresh: noop,
    });

    expect(undoPushMock).toHaveBeenCalledWith({
      type: "copy",
      copiedPath: "/dest/file.txt",
      parentDir: "/dest",
    });
  });

  // --- Same-parent guard ---

  it("treats a move into the source's own parent as a no-op skip", async () => {
    const result = await performFileTransfer("/dest/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("skipped");
    expect(moveEntryMock).not.toHaveBeenCalled();
    expect(conflictPromptMock).not.toHaveBeenCalled();
  });

  it("same-parent copy skips the self-conflict dialog and never overwrites", async () => {
    // Even with the source present in the target dir and overwrite forced,
    // a same-parent copy must route through copy-name generation.
    fetchDirectoryMock.mockResolvedValue({
      ok: true,
      data: { entries: [makeEntry("file.txt", "/dest/file.txt")] },
    });

    const result = await performFileTransfer("/dest/file.txt", "/dest", true, {
      onRefresh: noop,
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    expect(conflictPromptMock).not.toHaveBeenCalled();
    expect(copyEntryMock).toHaveBeenCalledWith("/dest/file.txt", "/dest", false, undefined);
  });

  it("shows toast on success", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(toastShowMock).toHaveBeenCalledWith("Moved file.txt to dest", "info");
  });

  it("shows copy toast for copy operations", async () => {
    await performFileTransfer("/src/file.txt", "/dest", true, {
      onRefresh: noop,
    });

    expect(toastShowMock).toHaveBeenCalledWith("Copied file.txt to dest", "info");
  });

  it("calls onRefresh on success", async () => {
    const refreshMock = vi.fn();

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: refreshMock,
    });

    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("broadcasts file change on success", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(broadcastMock).toHaveBeenCalledWith(["/src", "/dest"]);
    expect(pruneMock).toHaveBeenCalled();
  });

  // --- Suppress flags ---

  it("suppressUndo prevents undo recording", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      suppressUndo: true,
    });

    expect(undoPushMock).not.toHaveBeenCalled();
  });

  it("suppressToast prevents success toast", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      suppressToast: true,
    });

    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it("suppressBroadcast prevents broadcast and frecency prune", async () => {
    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
      suppressBroadcast: true,
    });

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it("suppressRefresh prevents onRefresh call", async () => {
    const refreshMock = vi.fn();

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: refreshMock,
      suppressRefresh: true,
    });

    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("all suppress flags together: only move/copy is called", async () => {
    const refreshMock = vi.fn();

    const result = await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: refreshMock,
      skipConflictCheck: true,
      suppressToast: true,
      suppressUndo: true,
      suppressBroadcast: true,
      suppressRefresh: true,
    });

    expect(result.ok).toBe(true);
    expect(moveEntryMock).toHaveBeenCalled();
    expect(undoPushMock).not.toHaveBeenCalled();
    expect(toastShowMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(pruneMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  // --- No side effects on failure ---

  it("does not record undo or broadcast on failure", async () => {
    moveEntryMock.mockResolvedValue({ ok: false, error: "not found" });

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(undoPushMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it("does not call onRefresh on failure", async () => {
    moveEntryMock.mockResolvedValue({ ok: false, error: "not found" });
    const refreshMock = vi.fn();

    await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: refreshMock,
    });

    expect(refreshMock).not.toHaveBeenCalled();
  });

  // --- Edge case: fetchDirectory fails ---

  it("proceeds without conflict prompt when fetchDirectory fails", async () => {
    fetchDirectoryMock.mockResolvedValue({ ok: false, error: "access denied" });

    const result = await performFileTransfer("/src/file.txt", "/dest", false, {
      onRefresh: noop,
    });

    expect(result.ok).toBe(true);
    expect(conflictPromptMock).not.toHaveBeenCalled();
    expect(moveEntryMock).toHaveBeenCalledWith("/src/file.txt", "/dest", false);
  });
});
