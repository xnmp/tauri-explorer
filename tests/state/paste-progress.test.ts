/**
 * Paste dispatch (#165, #388, #685). Both clipboard modes are now ordered
 * native sessions, so `pasteEntries` owns exactly two decisions: which
 * session to open, and whether the cut clipboard may be cleared afterwards.
 * Progress, conflicts and cancellation belong to the session itself and are
 * covered by move-operations/copy-operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const copyFiles = vi.hoisted(() => vi.fn(async () => null));
const moveFiles = vi.hoisted(() => vi.fn(async (): Promise<{ error: string | null; complete: boolean }> => ({ error: null, complete: true })));
const undo = vi.hoisted(() => ({ push: vi.fn(), invalidateRedo: vi.fn() }));

vi.mock("$lib/state/copy-operations", () => ({ copyFiles }));
vi.mock("$lib/state/move-operations", () => ({ moveFiles }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));

import { pasteEntries, type PasteSource } from "$lib/state/paste-operations";

function sources(n: number): PasteSource[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `file-${i}.bin`,
    path: `/src/file-${i}.bin`,
    size: 1024,
    modified: "2024-01-01T00:00:00.000Z",
  }));
}

const context = () => ({
  destPath: "/dest",
  existingEntries: [],
  onEntriesAdded: vi.fn(),
  onRefresh: vi.fn(async () => {}),
});

beforeEach(() => vi.clearAllMocks());

describe("pasteEntries", () => {
  it("sends a whole cut selection to one ordered move session", async () => {
    const ctx = context();
    const batch = sources(50);
    const error = await pasteEntries(batch, true, ctx);

    expect(error).toBeNull();
    expect(moveFiles).toHaveBeenCalledOnce();
    expect(moveFiles).toHaveBeenCalledWith(batch.map(({ path }) => path), "/dest", ctx);
    expect(copyFiles).not.toHaveBeenCalled();
  });

  it("leaves the inverse to native history rather than recording its own", async () => {
    await pasteEntries(sources(3), true, context());
    expect(undo.push).not.toHaveBeenCalled();
  });

  it("clears the cut clipboard only when every requested item arrived", async () => {
    const completed = vi.fn();
    await pasteEntries(sources(3), true, context(), completed);
    expect(completed).toHaveBeenCalledOnce();
  });

  it("keeps the cut clipboard when the session did not complete the selection", async () => {
    moveFiles.mockResolvedValue({ error: null, complete: false });
    const completed = vi.fn();
    const error = await pasteEntries(sources(3), true, context(), completed);
    expect(completed).not.toHaveBeenCalled();
    expect(error).toBeNull();
  });

  it("reports a session failure and keeps the cut clipboard", async () => {
    moveFiles.mockResolvedValue({ error: "Move incomplete: a.bin: denied", complete: false });
    const completed = vi.fn();
    const error = await pasteEntries(sources(1), true, context(), completed);
    expect(error).toContain("denied");
    expect(completed).not.toHaveBeenCalled();
  });

  it("delegates copy paste once and always releases the copy clipboard", async () => {
    const ctx = context();
    const batch = sources(3);
    const completed = vi.fn();
    await pasteEntries(batch, false, ctx, completed);
    expect(copyFiles).toHaveBeenCalledWith(batch.map(({ path }) => path), "/dest", ctx);
    expect(moveFiles).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledOnce();
  });
});
