/**
 * PluginWorkspace.moveFile (#881) shares the ordered move session with
 * cut/paste and drag-drop: it must go through `moveEntries`, not a
 * plugin-only per-item path, so a plugin move gets the same conflict
 * handling, undo recording, ordering, and refresh/broadcast behaviour.
 *
 * Mocking only the native session boundary (`$lib/api/move-session`) and
 * exercising the real `state/move-operations.ts` + `plugins/api.ts` proves
 * the production wiring, not just that some mock resolves `{ ok: true }`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopySessionOutcome } from "$lib/domain/copy-session";
import type { FileEntry, FileMutationReceipt } from "$lib/domain/file";

const moveEntries = vi.hoisted(() => vi.fn());
const undo = vi.hoisted(() => ({ push: vi.fn(), pushAndBroadcast: vi.fn() }));
vi.mock("$lib/api/move-session", () => ({ moveEntries }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));

import { createPluginContext } from "$lib/plugins/api";

const entry = (name: string): FileEntry => ({ name, path: `/dest/${name}`, kind: "file", size: 1, modified: "now" });
const receipt = (name: string): FileMutationReceipt => ({ path: `/dest/${name}`, entry: entry(name) });
const outcome = (items: CopySessionOutcome["items"], extra: Partial<CopySessionOutcome> = {}) =>
  ({ ok: true as const, data: { items, cancelled: false, warnings: [], ...extra } });

beforeEach(() => {
  vi.clearAllMocks();
  moveEntries.mockResolvedValue(outcome([{ status: "succeeded", receipt: receipt("a.txt") }]));
});

describe("PluginWorkspace.moveFile", () => {
  it("routes through the ordered move session with the requested source and destination", async () => {
    const { ctx, dispose } = createPluginContext("test-mover");
    const result = await ctx.workspace.moveFile("/src/a.txt", "/dest");

    expect(moveEntries).toHaveBeenCalledOnce();
    expect(moveEntries.mock.calls[0][0]).toEqual(["/src/a.txt"]);
    expect(moveEntries.mock.calls[0][1]).toBe("/dest");
    expect(result).toEqual({ ok: true });
    dispose();
  });

  it("records no renderer-owned undo action — the session's native history is the inverse", async () => {
    const { ctx, dispose } = createPluginContext("test-mover");
    await ctx.workspace.moveFile("/src/a.txt", "/dest");

    expect(undo.push).not.toHaveBeenCalled();
    expect(undo.pushAndBroadcast).not.toHaveBeenCalled();
    dispose();
  });

  it("surfaces a session conflict/failure as a plugin move failure", async () => {
    moveEntries.mockResolvedValue(outcome([{ status: "failed", error: "permission denied" }]));
    const { ctx, dispose } = createPluginContext("test-mover");
    const result = await ctx.workspace.moveFile("/src/a.txt", "/dest");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission denied");
    dispose();
  });

  it("reports a conflict skip/cancel as an unsuccessful, non-error move", async () => {
    moveEntries.mockResolvedValue(outcome([{ status: "skipped" }]));
    const { ctx, dispose } = createPluginContext("test-mover");
    const result = await ctx.workspace.moveFile("/src/a.txt", "/dest");

    expect(result).toEqual({ ok: false, error: "skipped" });
    dispose();
  });
});
