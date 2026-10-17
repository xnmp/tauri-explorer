/** A navigation retires the peek tree it leaves only when it commits. Until
 * then the displayed peeks, their snapshots and selected children stay; a
 * failed navigation keeps them. Stale peek work is still cancelled at intent. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source, loads } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) }, loads: [] as string[] }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => { loads.push(path); return source.current(path); }, cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { compileExplorer } from "./folder-peek-harness";

const flushSync = () => client.flush();
const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const a = entry("/r/a"), b = entry("/r/b"), child = entry("/r/a/child", "file"), elsewhere = entry("/other/x", "file");
let trees: Record<string, FileEntry[]>;
let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
const rendered: string[][] = [];
function create(): ExplorerInstance {
  let pane!: ExplorerInstance;
  effects.push(client.effect_root(() => {
    pane = createExplorerState({ currentPath: "/r", entries: [a, b], sortBy: "name", sortAscending: true, viewMode: "details" });
    client.render_effect(() => { rendered.push(pane.detailRows.rows.map(row => row.kind === "entry" ? row.entry.path : row.kind === "peek-state" ? row.message : row.kind)); });
  }));
  panes.push(pane);
  return pane;
}
async function settle(ms = 0) { for (let i = 0; i < 5; i++) { flushSync(); await vi.advanceTimersByTimeAsync(0); } await vi.advanceTimersByTimeAsync(ms); flushSync(); }
/** Holds the next listing of `path` until released (or the test ends). */
const held = new Set<() => void>();
function hold(path: string) {
  let release!: (result: DirectoryListingResult) => void;
  const previous = source.current;
  source.current = p => p === path ? new Promise(resolve => { release = resolve; }) : previous(p);
  const settleHold = (result: DirectoryListingResult) => { held.delete(abandon); source.current = previous; release?.(result); };
  const abandon = () => settleHold({ ok: false, cancelled: true, error: "test ended" });
  held.add(abandon);
  return settleHold;
}
async function peekedWithSelectedChild() {
  const pane = create();
  await pane.togglePeek(a.path); await settle();
  pane.selectEntry(child);
  expect(pane.selectedPaths).toEqual(new Set([child.path]));
  rendered.length = 0; loads.length = 0;
  return pane;
}

beforeEach(async () => {
  createExplorerState = await compileExplorer();
  vi.useFakeTimers(); vi.setSystemTime(20_000); cancelPendingRefreshes();
  rendered.length = 0; loads.length = 0;
  trees = { "/r": [a, b], [a.path]: [child], [b.path]: [], "/other": [elsewhere] };
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  [...held].forEach(abandon => abandon());
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers();
  effects.splice(0).forEach(dispose => dispose());
});

it("keeps peeked children and their selection while a navigation is pending", async () => {
  const pane = await peekedWithSelectedChild();
  const release = hold("/other");
  const navigation = pane.navigateTo("/other", { autoEnterSingleSubdir: false }); await settle();
  expect(pane.displayEntries).toEqual([a, child, b]);
  expect(pane.selectedPaths).toEqual(new Set([child.path]));
  release({ ok: true, path: "/other", entries: [elsewhere] }); await navigation; await settle();
  expect(pane.displayEntries).toEqual([elsewhere]);
  expect(pane.selectedPaths).toEqual(new Set([elsewhere.path]));
});

it("a failed navigation keeps the peek tree and the selected child without reloading it", async () => {
  const pane = await peekedWithSelectedChild();
  const release = hold("/missing");
  const navigation = pane.navigateTo("/missing", { autoEnterSingleSubdir: false }); await settle();
  release({ ok: false, error: "No such directory" }); await navigation; await settle();
  expect(pane.displayEntries).toEqual([a, child, b]);
  expect(pane.selectedPaths).toEqual(new Set([child.path]));
  expect(rendered.every(rows => rows.includes(child.path))).toBe(true);
  expect(rendered.some(rows => rows.includes("Loading…"))).toBe(false);
});

it("cancels a peek refresh scheduled before the navigation intent", async () => {
  const pane = await peekedWithSelectedChild();
  pane.directoryChanged({ path: a.path, observedAt: Date.now(), origin: "watcher" });
  const release = hold("/other");
  const navigation = pane.navigateTo("/other", { autoEnterSingleSubdir: false });
  await settle(2_500);
  expect(loads).toEqual(["/other"]);
  release({ ok: true, path: "/other", entries: [elsewhere] }); await navigation; await settle(2_500);
  expect(loads).toEqual(["/other"]);
});
