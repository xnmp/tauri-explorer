import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) } }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => source.current(path), cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { settingsStore } from "$lib/state/settings.svelte";
import { compileExplorer } from "./folder-peek-harness";

// List cards (#1240): column-flow List is a peek tree like Details.
const entry = (path: string, kind: FileEntry["kind"] = "directory", size = 1): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size, modified: "" });
const a = entry("/r/a"), b = entry("/r/b");
const big = entry("/r/a/big.txt", "file", 10), small = entry("/r/a/small.txt", "file", 900), mid = entry("/r/a/Mid.txt", "file", 50);
const trees: Record<string, FileEntry[]> = { "/r": [a, b], [a.path]: [big, small, mid], [b.path]: [] };
let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
const create = (viewMode: "details" | "list" | "tiles" = "list") => {
  let pane!: ExplorerInstance;
  effects.push(client.effect_root(() => {
    pane = createExplorerState({ currentPath: "/r", entries: [a, b], sortBy: "size", sortAscending: false, viewMode });
    client.render_effect(() => { pane.displayEntries; pane.detailRows; });
  }));
  panes.push(pane);
  return pane;
};
async function settle() { for (let i = 0; i < 3; i++) { client.flush(); await vi.advanceTimersByTimeAsync(0); } client.flush(); }
beforeEach(async () => {
  createExplorerState = await compileExplorer();
  vi.useFakeTimers(); settingsStore.reset();
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => { await Promise.all(panes.splice(0).map(p => p.destroy())); cancelPendingRefreshes(); vi.useRealTimers(); settingsStore.reset(); effects.splice(0).forEach(dispose => dispose()); });

it("peeks in List, sorting every level by name like the List root, and Details by its own sort", async () => {
  const pane = create("list");
  expect(pane.peekEnabled).toBe(true);
  await pane.togglePeek(a.path); await settle();
  expect(pane.displayEntries.map(e => e.name)).toEqual(["a", "big.txt", "Mid.txt", "small.txt", "b"]);
  // The pane's Details sort is size, descending.
  pane.setViewMode("details"); await settle();
  expect(pane.displayEntries.map(e => e.name)).toEqual(["a", "small.txt", "Mid.txt", "big.txt", "b"]);
  pane.setViewMode("tiles"); await settle();
  expect(pane.peekEnabled).toBe(false);
  expect(pane.displayEntries).toEqual([a, b]);
});

it("records user peek changes for renderers, but not pruning, refresh or navigation", async () => {
  const pane = create("list");
  expect(pane.peekChange).toBeNull();
  await pane.togglePeek(a.path); await settle();
  expect(pane.peekChange).toEqual({ path: a.path, serial: 1 });
  await pane.refresh({ silent: true }); await settle();
  expect(pane.peekChange?.serial).toBe(1);
  source.current = async path => ({ ok: true, path, entries: path === "/r" ? [b] : trees[path] ?? [] });
  await pane.refresh({ silent: true }); await settle();
  expect(pane.expandedPaths.has(a.path)).toBe(false);
  expect(pane.peekChange?.serial).toBe(1);
  await pane.togglePeek(b.path); await settle();
  pane.collapseAllPeeks();
  expect(pane.peekChange).toEqual({ path: "/r", serial: 3 });
});

it("exposes each peek's listing state", async () => {
  const pane = create("list");
  let release!: (value: DirectoryListingResult) => void;
  source.current = path => path === a.path ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, path, entries: trees[path] ?? [] });
  await pane.togglePeek(a.path); await settle();
  expect(pane.peekStatus(a.path)).toBe("loading");
  release({ ok: true, path: a.path, entries: trees[a.path] }); await settle();
  expect(pane.peekStatus(a.path)).toBe("loaded");
  expect(pane.peekStatus(b.path)).toBeUndefined();
});

it("remembers card heights per pane for the session, across collapse and re-open", async () => {
  const left = create("list"), right = create("list");
  await left.togglePeek(a.path); await right.togglePeek(a.path); await settle();
  left.setListCardRows(a.path, 3);
  expect(left.listCardRows(a.path)).toBe(3);
  expect(right.listCardRows(a.path)).toBeUndefined();
  expect(left.peekChange).toMatchObject({ path: a.path });
  await left.togglePeek(a.path); await left.togglePeek(a.path); await settle();
  expect(left.listCardRows(a.path)).toBe(3);
  const serial = left.peekChange!.serial;
  left.setListCardRows(a.path, 3);
  expect(left.peekChange!.serial).toBe(serial);
  left.setViewMode("tiles");
  left.setListCardRows(a.path, 5);
  expect(left.listCardRows(a.path)).toBe(3);
});
