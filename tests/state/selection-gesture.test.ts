/**
 * #1169: a marquee drag replaces the selection every frame. The settled
 * selection (read by the preview pane and plugin inspector) holds the
 * selection the gesture started from until the gesture ends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";

type LoadFn = (path: string) => Promise<DirectoryListingResult>;
const { loadImpl } = vi.hoisted(() => ({ loadImpl: { current: (async () => ({ ok: false, error: "unset" })) as LoadFn } }));
vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({ load: (path: string) => loadImpl.current(path), cleanup: async () => {} }),
}));

import { createExplorerState } from "$lib/state/explorer.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

const entry = (name: string): FileEntry => ({ name, path: `/root/${name}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" });
const names = (entries: FileEntry[]) => entries.map((e) => e.name);

beforeEach(() => {
  localStorage.clear();
  settingsStore.reset();
  loadImpl.current = async (path) => ({ ok: true, path, entries: [entry("a.png"), entry("b.png"), entry("c.png")] });
});

describe("settled selection during a selection gesture", () => {
  it("follows the live selection when no gesture is active", async () => {
    const explorer = createExplorerState();
    await explorer.navigateTo("/root");
    explorer.selectByIndices([1]);
    expect(names(explorer.getSettledSelectedEntries())).toEqual(["b.png"]);
    expect(explorer.selectionGestureActive).toBe(false);
  });

  it("holds the pre-gesture selection while the gesture changes the live selection", async () => {
    const explorer = createExplorerState();
    await explorer.navigateTo("/root");
    explorer.selectByIndices([0]);
    explorer.beginSelectionGesture();
    expect(explorer.selectionGestureActive).toBe(true);
    explorer.selectByIndices([]);
    explorer.selectByIndices([1]);
    explorer.selectByIndices([1, 2]);
    expect(names(explorer.getSelectedEntries())).toEqual(["b.png", "c.png"]);
    expect(names(explorer.getSettledSelectedEntries())).toEqual(["a.png"]);
    explorer.endSelectionGesture();
    expect(explorer.selectionGestureActive).toBe(false);
    expect(names(explorer.getSettledSelectedEntries())).toEqual(["b.png", "c.png"]);
  });

  it("holds an empty pre-gesture selection", async () => {
    const explorer = createExplorerState();
    await explorer.navigateTo("/root");
    explorer.clearSelection();
    explorer.beginSelectionGesture();
    explorer.selectByIndices([2]);
    expect(explorer.getSettledSelectedEntries()).toEqual([]);
    explorer.endSelectionGesture();
    expect(names(explorer.getSettledSelectedEntries())).toEqual(["c.png"]);
  });
});
