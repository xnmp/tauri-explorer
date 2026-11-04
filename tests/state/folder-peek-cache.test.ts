/** Re-opening a Folder Peek paints its remembered listing at once (#1509).
 * The cache is a paint source only: the peek's first read still revalidates it
 * through pane-refresh, and a directory change this window has seen evicts it. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source, loads } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) }, loads: [] as string[] }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => { loads.push(path); return source.current(path); }, cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { broadcastFileChange } from "$lib/state/file-events";
import { compileExplorer } from "./folder-peek-harness";

const flushSync = () => client.flush();
const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const a = entry("/r/a"), b = entry("/r/b"), child = entry("/r/a/child", "file"), added = entry("/r/a/added", "file");
const trees: Record<string, FileEntry[]> = { "/r": [a, b], [a.path]: [child], [b.path]: [] };

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
async function immediate() { for (let i = 0; i < 5; i++) { flushSync(); await vi.advanceTimersByTimeAsync(0); } flushSync(); }
const sawLoading = () => rendered.some(rows => rows.includes("Loading…"));
/** The next listing of `path` stays pending until released. */
function holdNext(path: string) {
  let release!: (result: DirectoryListingResult) => void;
  const previous = source.current;
  source.current = requested => requested === path ? new Promise(resolve => { release = resolve; }) : previous(requested);
  return (entries: FileEntry[]) => { source.current = previous; release({ ok: true, path, entries }); };
}

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

async function openThenClose(pane: ExplorerInstance) {
  await pane.togglePeek(a.path); await immediate();
  expect(pane.displayEntries).toEqual([a, child, b]);
  await pane.togglePeek(a.path); await immediate();
  expect(pane.displayEntries).toEqual([a, b]);
}

it("re-opening a peek paints its remembered children before any listing resolves", async () => {
  const pane = create();
  await openThenClose(pane);
  const release = holdNext(a.path);
  loads.length = 0; rendered.length = 0;
  await pane.togglePeek(a.path); await immediate();
  // Painted from the cache, with the revalidating read still pending.
  expect(pane.displayEntries).toEqual([a, child, b]);
  await vi.advanceTimersByTimeAsync(500); flushSync();
  expect(sawLoading()).toBe(false);
  expect(rendered.every(rows => !rows.includes(a.path) || rows.includes(child.path))).toBe(true);
  // Closed peeks hold no watch, so the first read still revalidates once.
  expect(loads).toEqual([a.path]);
  release([child, added]); await immediate();
  expect(pane.displayEntries).toEqual([a, added, child, b]);
});

it("an unchanged revalidation keeps the remembered entry identities", async () => {
  const pane = create();
  await openThenClose(pane);
  await pane.togglePeek(a.path); await immediate();
  expect(pane.displayEntries[1]).toBe(child);
});

it("another pane opening the same folder paints from the window's cache", async () => {
  const left = create();
  await left.togglePeek(a.path); await immediate();
  const right = create();
  const release = holdNext(a.path);
  await right.togglePeek(a.path); await immediate();
  expect(right.displayEntries).toEqual([a, child, b]);
  release([child]); await immediate();
});

it("a directory change broadcast evicts the remembered listing", async () => {
  const pane = create();
  await openThenClose(pane);
  broadcastFileChange([a.path]);
  const release = holdNext(a.path);
  rendered.length = 0;
  await pane.togglePeek(a.path); await immediate();
  expect(pane.displayEntries).toEqual([a, b]);
  await vi.advanceTimersByTimeAsync(150); flushSync();
  expect(rendered.at(-1)).toContain("Loading…");
  release([added]); await immediate();
  expect(pane.displayEntries).toEqual([a, added, b]);
});

it("a failed listing is never remembered", async () => {
  const pane = create();
  await openThenClose(pane);
  source.current = async path => path === a.path ? { ok: false, error: "denied" } : { ok: true, path, entries: trees[path] ?? [] };
  await pane.togglePeek(a.path); await immediate();
  expect(rendered.at(-1)).toContain("Can't open folder: denied");
  await pane.togglePeek(a.path); await immediate();
  const release = holdNext(a.path);
  await pane.togglePeek(a.path); await immediate();
  expect(pane.displayEntries).toEqual([a, b]);
  release([child]); await immediate();
  expect(pane.displayEntries).toEqual([a, child, b]);
});
