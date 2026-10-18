/** A peek's first listing (expand, re-open, view return, retry) reads at once
 * through pane-refresh; only watcher notifications wait for refresh-manager's
 * debounce and storm interval. "Loading…" appears only after a real 150ms. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source, loads } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) }, loads: [] as string[] }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => { loads.push(path); return source.current(path); }, cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {},
  // A backend reply without a receipt entry: the parent must be re-listed.
  renameEntry: async (path: string, name: string) => ({ ok: true, data: { path: `${path.slice(0, path.lastIndexOf("/"))}/${name}` } }) }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { compileExplorer } from "./folder-peek-harness";

const flushSync = () => client.flush();
const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const a = entry("/r/a"), b = entry("/r/b"), child = entry("/r/a/child", "file");
const trees: Record<string, FileEntry[]> = { "/r": [a, b], [a.path]: [child], [b.path]: [] };

let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
/** Every Details row set the pane rendered, so a transient Loading row is seen. */
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
/** Microtasks and zero-delay work only: no debounce or interval elapses. */
async function immediate() { for (let i = 0; i < 5; i++) { flushSync(); await vi.advanceTimersByTimeAsync(0); } flushSync(); }
const sawLoading = () => rendered.some(rows => rows.includes("Loading…"));

beforeEach(async () => {
  createExplorerState = await compileExplorer();
  vi.useFakeTimers(); vi.setSystemTime(10_000); cancelPendingRefreshes();
  loads.length = 0; rendered.length = 0;
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers();
  effects.splice(0).forEach(dispose => dispose());
});

it("expanding with an instant listing shows children without a Loading row", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await immediate();
  expect(pane.displayEntries).toEqual([a, child, b]);
  expect(sawLoading()).toBe(false);
});

it("collapse and re-open inside the watcher interval read immediately", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await immediate();
  await pane.togglePeek(a.path); await immediate();
  expect(pane.displayEntries).toEqual([a, b]);
  loads.length = 0; rendered.length = 0;
  await pane.togglePeek(a.path); await immediate();
  expect(loads).toEqual([a.path]);
  expect(pane.displayEntries).toEqual([a, child, b]);
  expect(sawLoading()).toBe(false);
});

it("returning from Tiles to Details restores a nested peek immediately", async () => {
  const nested = entry("/r/a/nested"), deep = entry("/r/a/nested/deep", "file");
  source.current = async path => ({ ok: true, path, entries: path === a.path ? [child, nested] : path === nested.path ? [deep] : trees[path] ?? [] });
  const pane = create();
  await pane.togglePeek(a.path); await immediate();
  await pane.togglePeek(nested.path); await immediate();
  pane.setViewMode("tiles"); await immediate();
  // Tiles peeks top-level folders only (#1241): the nested peek is dormant.
  expect(pane.displayEntries).toEqual([a, nested, child, b]);
  rendered.length = 0;
  pane.setViewMode("details"); await immediate();
  expect(pane.displayEntries).toEqual([a, nested, deep, child, b]);
  expect(sawLoading()).toBe(false);
});

it("two panes peeking one folder each read it without sharing a storm window", async () => {
  const left = create(), right = create();
  await left.togglePeek(a.path); await immediate();
  await right.togglePeek(a.path); await immediate();
  expect(loads.filter(path => path === a.path)).toHaveLength(2);
  expect(right.displayEntries).toEqual([a, child, b]);
});

it("an explicit refresh retries a failed peek immediately", async () => {
  const pane = create();
  source.current = async path => path === a.path ? { ok: false, error: "denied" } : { ok: true, path, entries: trees[path] ?? [] };
  await pane.togglePeek(a.path); await immediate();
  expect(rendered.at(-1)).toContain("Can't open folder: denied");
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
  await pane.refresh({ silent: true, explicit: true }); await immediate();
  expect(pane.displayEntries).toEqual([a, child, b]);
});

it("a slow listing shows Loading only once 150ms have really passed", async () => {
  const pane = create();
  let release!: (result: DirectoryListingResult) => void;
  source.current = path => path === a.path ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, path, entries: trees[path] ?? [] });
  await pane.togglePeek(a.path); await immediate();
  expect(loads).toContain(a.path);
  await vi.advanceTimersByTimeAsync(149); flushSync();
  expect(sawLoading()).toBe(false);
  await vi.advanceTimersByTimeAsync(1); flushSync();
  expect(rendered.at(-1)).toContain("Loading…");
  release({ ok: true, path: a.path, entries: [child] }); await immediate();
  expect(pane.displayEntries).toEqual([a, child, b]);
});

it("watcher notifications still wait for refresh-manager scheduling", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await immediate();
  loads.length = 0;
  pane.directoryChanged({ path: a.path, observedAt: Date.now(), origin: "watcher" }); await immediate();
  expect(loads).toEqual([]);
  await vi.advanceTimersByTimeAsync(2_000); flushSync();
  expect(loads).toEqual([a.path]);
});

it("a rename without a receipt entry re-lists its parent at once, root or peek", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await immediate();
  loads.length = 0;
  pane.startRename(child);
  expect(await pane.rename("renamed.txt")).toBeNull(); await immediate();
  expect(loads).toEqual([a.path]);
  loads.length = 0;
  pane.startRename(b);
  expect(await pane.rename("b2")).toBeNull(); await immediate();
  expect(loads).toEqual(["/r"]);
});
