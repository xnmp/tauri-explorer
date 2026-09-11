/**
 * A drag-and-drop is one ordered native session (#163, #685). Whatever the
 * item count, the drop produces exactly one session call, one history entry
 * owned by native, one toast, one refresh and one broadcast; the renderer
 * records no inverse of its own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const transfer = vi.hoisted(() => vi.fn());
const copyFiles = vi.hoisted(() => vi.fn(async () => null));
const moveFiles = vi.hoisted(() => vi.fn(async (): Promise<{ error: string | null; complete: boolean }> => ({ error: null, complete: true })));
const undo = vi.hoisted(() => ({ push: vi.fn(), pushAndBroadcast: vi.fn(), invalidateRedo: vi.fn() }));

vi.mock("$lib/state/file-transfer", () => ({ performFileTransfer: transfer }));
vi.mock("$lib/state/copy-operations", () => ({ copyFiles }));
vi.mock("$lib/state/move-operations", () => ({ moveFiles }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));

import { handleFileDropMany } from "$lib/state/drop-operations";

beforeEach(() => vi.clearAllMocks());

const opts = () => ({ onRefresh: vi.fn() });

describe("handleFileDropMany", () => {
  it("relocates a multi-item drop through one ordered move session", async () => {
    const options = opts();
    await handleFileDropMany(["/src/a.txt", "/src/b.txt", "/src/c.txt"], "/dest", false, options);

    expect(moveFiles).toHaveBeenCalledOnce();
    expect(moveFiles).toHaveBeenCalledWith(["/src/a.txt", "/src/b.txt", "/src/c.txt"], "/dest", {
      onRefresh: options.onRefresh, broadcastToOtherWindows: undefined,
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("keeps the inverse native-owned instead of pushing a renderer undo action", async () => {
    await handleFileDropMany(["/src/a.txt", "/src/b.txt"], "/dest", false, {
      onRefresh: vi.fn(), broadcastToOtherWindows: true,
    });
    expect(undo.push).not.toHaveBeenCalled();
    expect(undo.pushAndBroadcast).not.toHaveBeenCalled();
  });

  it("sends a single-item move through the same session, not a per-item transfer", async () => {
    const options = opts();
    await handleFileDropMany(["/src/a.txt"], "/dest", false, options);
    expect(moveFiles).toHaveBeenCalledWith(["/src/a.txt"], "/dest", {
      onRefresh: options.onRefresh, broadcastToOtherWindows: undefined,
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("delegates an ordered copy batch once and leaves history to the native session", async () => {
    const onRefresh = vi.fn();
    await handleFileDropMany(["/src/a.txt", "/src/b.txt"], "/dest", true, {
      onRefresh, broadcastToOtherWindows: true,
    });

    expect(copyFiles).toHaveBeenCalledOnce();
    expect(copyFiles).toHaveBeenCalledWith(["/src/a.txt", "/src/b.txt"], "/dest", {
      onRefresh, broadcastToOtherWindows: true,
    });
    expect(moveFiles).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("delegates a single copy through the same native copy session", async () => {
    const options = opts();
    await handleFileDropMany(["/src/a.txt"], "/dest", true, options);
    expect(copyFiles).toHaveBeenCalledWith(["/src/a.txt"], "/dest", {
      onRefresh: options.onRefresh, broadcastToOtherWindows: undefined,
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("does nothing for an empty path list", async () => {
    await handleFileDropMany([], "/dest", false, opts());
    expect(moveFiles).not.toHaveBeenCalled();
    expect(copyFiles).not.toHaveBeenCalled();
    expect(undo.push).not.toHaveBeenCalled();
  });
});
