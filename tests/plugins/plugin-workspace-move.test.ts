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
const explorerRefresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("$lib/api/move-session", () => ({ moveEntries }));
vi.mock("$lib/state/undo.svelte", () => ({ undoStore: undo }));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: {
  getAllExplorers: () => [{ refresh: explorerRefresh }],
  getActiveExplorer: () => null,
} }));

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

  // Kills the "onRefresh is a no-op" mutant: without this assertion, deleting
  // the session's refresh callback body (or never wiring `onRefresh` at all)
  // still leaves every other assertion in this file green.
  it("refreshes every open explorer pane after the session settles", async () => {
    const { ctx, dispose } = createPluginContext("test-mover");
    await ctx.workspace.moveFile("/src/a.txt", "/dest");

    expect(explorerRefresh).toHaveBeenCalledOnce();
    expect(explorerRefresh).toHaveBeenCalledWith({ silent: true });
    dispose();
  });

  it("still refreshes panes when the session reports a conflict skip", async () => {
    moveEntries.mockResolvedValue(outcome([{ status: "skipped" }]));
    const { ctx, dispose } = createPluginContext("test-mover");
    await ctx.workspace.moveFile("/src/a.txt", "/dest");

    expect(explorerRefresh).toHaveBeenCalledOnce();
    dispose();
  });

  it("surfaces an uncertain move (incomplete source removal) as a non-skipped error", async () => {
    moveEntries.mockResolvedValue(outcome([{ status: "failed", error: "Move is uncertain: destination committed but source cleanup did not finish" }]));
    const { ctx, dispose } = createPluginContext("test-mover");
    const result = await ctx.workspace.moveFile("/src/a.txt", "/dest");

    expect(result.ok).toBe(false);
    expect(result.error).not.toBe("skipped");
    expect(result.error).toContain("uncertain");
    dispose();
  });

  it("treats a same-directory relocation as a no-op skip, not a successful move", async () => {
    const { ctx, dispose } = createPluginContext("test-mover");
    const result = await ctx.workspace.moveFile("/dest/a.txt", "/dest");

    expect(result).toEqual({ ok: false, error: "skipped" });
    expect(moveEntries).not.toHaveBeenCalled();
    dispose();
  });
});
