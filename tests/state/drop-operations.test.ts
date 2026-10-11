/**
 * A drag-and-drop is one ordered native session (#163, #685). Whatever the
 * item count, the drop produces exactly one session call, one history entry
 * owned by native, one toast, one refresh and one broadcast; the renderer
 * records no inverse of its own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const copyFiles = vi.hoisted(() => vi.fn(async () => null));
const moveFiles = vi.hoisted(() => vi.fn(async (): Promise<{ error: string | null; complete: boolean }> => ({ error: null, complete: true })));
const undo = vi.hoisted(() => ({ push: vi.fn(), pushAndBroadcast: vi.fn(), invalidateRedo: vi.fn() }));

vi.mock("$lib/state/copy-operations", () => ({ copyFiles }));
vi.mock("$lib/state/move-operations", () => ({ moveFiles }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));

import { dragState } from "$lib/state/drag.svelte";
import { handleFileDropMany, getDropSourcePaths, getDropSourcePath } from "$lib/state/drop-operations";

beforeEach(() => { vi.clearAllMocks(); dragState.clear(); });

const opts = () => ({ onRefresh: vi.fn() });

describe("handleFileDropMany", () => {
  it("relocates a multi-item drop through one ordered move session", async () => {
    const options = opts();
    await handleFileDropMany(["/src/a.txt", "/src/b.txt", "/src/c.txt"], "/dest", false, options);

    expect(moveFiles).toHaveBeenCalledOnce();
    expect(moveFiles).toHaveBeenCalledWith(["/src/a.txt", "/src/b.txt", "/src/c.txt"], "/dest", {
      onRefresh: options.onRefresh, broadcastToOtherWindows: undefined,
    });
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
  });

  it("delegates a single copy through the same native copy session", async () => {
    const options = opts();
    await handleFileDropMany(["/src/a.txt"], "/dest", true, options);
    expect(copyFiles).toHaveBeenCalledWith(["/src/a.txt"], "/dest", {
      onRefresh: options.onRefresh, broadcastToOtherWindows: undefined,
    });
  });

  it("does nothing for an empty path list", async () => {
    await handleFileDropMany([], "/dest", false, opts());
    expect(moveFiles).not.toHaveBeenCalled();
    expect(copyFiles).not.toHaveBeenCalled();
    expect(undo.push).not.toHaveBeenCalled();
  });
});


describe("DOM drop path admission", () => {
  const transfer = (payload: Record<string, string>) => ({ getData: (type: string) => payload[type] ?? "" }) as DataTransfer;

  it("preserves batch order while retaining the primary-path helper contract", () => {
    const payload = transfer({ "application/x-explorer-path": "/b.png", "application/x-explorer-paths": '["/a.png","/b.png"]' });
    expect(getDropSourcePaths(payload)).toEqual(["/a.png", "/b.png"]);
    expect(getDropSourcePath(payload)).toBe("/b.png");
  });

  it("rejects malformed arrays without substituting a persisted live selection", () => {
    dragState.start({ path: "/old.png", name: "old.png", kind: "file", paths: ["/old.png", "/other.png"] });
    const payload = transfer({ "application/x-explorer-path": "/a.png", "application/x-explorer-paths": '["/a.png", null]' });
    expect(getDropSourcePaths(payload)).toEqual([]); expect(getDropSourcePath(payload)).toBeNull();
  });

  it("requires an Explorer MIME marker for the cross-window fallback", () => {
    dragState.start({ path: "/a.png", name: "a.png", kind: "file", paths: ["/a.png", "/b.png"] });
    expect(getDropSourcePaths(transfer({}))).toEqual([]);
    expect(getDropSourcePaths(transfer({ "application/x-explorer-kind": "file" }))).toEqual(["/a.png", "/b.png"]);
    dragState.clear();
  });
});
