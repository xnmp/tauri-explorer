import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
const flushSync = () => client.flush();
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source, loads } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) }, loads: [] as string[] }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => { loads.push(path); return source.current(path); }, cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import { type ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { settingsStore } from "$lib/state/settings.svelte";
import { compileClient, compileExplorer } from "./folder-peek-harness";

const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const a = entry("/r/a"), b = entry("/r/b"), child = entry("/r/a/child", "file"), nested = entry("/r/a/nested");
const trees: Record<string, FileEntry[]> = { "/r": [a, b], [a.path]: [child, nested], [nested.path]: [entry("/r/a/nested/deep", "file")], [b.path]: [] };
let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
const create = (entries: FileEntry[] = [a, b]) => { let pane!: ExplorerInstance; effects.push(client.effect_root(() => { pane = createExplorerState({ currentPath: "/r", entries, sortBy: "name", sortAscending: true, viewMode: "details" }); client.render_effect(() => { pane.displayEntries; pane.detailRows; }); })); panes.push(pane); return pane; };
// Zero-delay settling: first peek listings read immediately, so no test waits
// out a watcher debounce or storm interval to see them.
async function settle(ms = 0) { for (let i = 0; i < 3; i++) { flushSync(); await vi.advanceTimersByTimeAsync(ms); } flushSync(); }
beforeEach(async () => {
  createExplorerState = await compileExplorer();
  vi.useFakeTimers(); loads.length = 0; settingsStore.reset(); source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] }); });
afterEach(async () => { await Promise.all(panes.splice(0).map(p => p.destroy())); cancelPendingRefreshes(); vi.useRealTimers(); settingsStore.reset(); effects.splice(0).forEach(dispose => dispose()); });
it("persists membership through navigation/back/view switches, stays pane-local, and drops invisible selection", async () => {
  const pane = create(); await pane.togglePeek(a.path); await settle(); await pane.togglePeek(nested.path); await settle();
  const deep = trees[nested.path][0];
  expect(pane.displayEntries).toContain(deep);
  // Tiles peeks top-level folders only (#1241): the nested peek goes dormant
  // and its child's selection with it; the top-level peek stays.
  pane.selectEntry(deep); pane.setViewMode("tiles");
  expect([...pane.selectedPaths]).toEqual([]); expect(pane.focusedEntry?.path).toBe(nested.path);
  expect(pane.displayEntries).toEqual([a, nested, child, b]);
  pane.setViewMode("details"); await settle(); expect(pane.displayEntries).toContain(deep);
  expect(create().expandedPaths.size).toBe(0);
  await pane.navigateTo("/r"); await pane.navigateTo(a.path); await pane.goBack(); await settle();
  expect(pane.currentPath).toBe("/r"); expect(pane.expandedPaths.has(a.path)).toBe(true); expect(pane.displayEntries).toContain(child);
});
it("repairs hidden anchors without selecting the folder and keeps other selection levels through refresh", async () => {
  const pane = create(); await pane.togglePeek(a.path); await settle(); pane.selectEntry(child); pane.focusEntry(b);
  await pane.togglePeek(a.path); expect(pane.focusedEntry?.path).toBe(a.path); expect([...pane.selectedPaths]).toEqual([]); expect(pane.state.selectionAnchorPath).toBeNull();
  await pane.togglePeek(a.path); await settle(); pane.selectPaths([child.path, b.path], child.path);
  await pane.refresh({ silent: true }); flushSync(); expect([...pane.selectedPaths]).toEqual([child.path, b.path]);
  pane.collapseAllPeeks(); expect([...pane.selectedPaths]).toEqual([b.path]); expect(pane.state.selectionAnchorPath).toBeNull();
});
it("rejects late success/error responses from collapsed and replaced resources", async () => {
  const pane = create(); let release!: (value: DirectoryListingResult) => void;
  source.current = path => path === a.path ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, path, entries: [] });
  await pane.togglePeek(a.path); await settle();
  await pane.togglePeek(a.path); source.current = async path => ({ ok: true, path, entries: [entry(path + "/new", "file")] });
  await pane.togglePeek(a.path); await settle();
  release({ ok: true, path: a.path, entries: [child] }); await settle();
  expect(pane.displayEntries.map(e => e.path)).toContain("/r/a/new"); expect(pane.displayEntries).not.toContain(child);
});
it("prunes deleted remembered branches and their selected descendants after a raw parent refresh", async () => {
  const pane = create(); await pane.togglePeek(a.path); await settle(); pane.selectEntry(child);
  source.current = async path => ({ ok: true, path, entries: path === "/r" ? [b] : [] });
  await pane.refresh({ silent: true }); await settle();
  expect(pane.expandedPaths.has(a.path)).toBe(false); expect([...pane.selectedPaths]).toEqual([]); expect(pane.peekWatchSnapshot()).toEqual([]);
});
it("keeps root-only name filtering and rejects invisible requested paths", async () => {
  const pane = create(); await pane.togglePeek(a.path); await settle();
  pane.setFilter("a"); await settle(); expect(pane.displayEntries).toContain(child); expect(pane.ownDisplayEntries).toEqual([a]);
  pane.selectAll(); expect([...pane.selectedPaths]).toEqual([a.path]);
  pane.selectPaths(["/not-visible"]); expect([...pane.selectedPaths]).toEqual([]);
  pane.setFilter("b"); await settle(); expect(pane.displayEntries).toEqual([b]); expect(pane.expandedPaths.has(a.path)).toBe(true); expect(pane.peekWatchSnapshot()).toEqual([]);
});
it.each(["collapse", "view", "navigation", "destroy"])("does not revive a first toggle after %s while its module is loading", async action => {
  const session = await compileClient("folder-peek-session.svelte");
  let release!: (session: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
  const peek = await compileClient("folder-peek.svelte", { "./folder-peek-session.svelte": pending });
  createExplorerState = (await compileClient("explorer.svelte", { "./folder-peek.svelte": peek })).createExplorerState as typeof createExplorerState;
  const pane = create();
  const opening = pane.togglePeek(a.path);
  let closing: Promise<void> | undefined;
  if (action === "collapse") pane.collapseAllPeeks();
  if (action === "view") { pane.setViewMode("tiles"); pane.setViewMode("details"); }
  if (action === "navigation") await pane.navigateTo("/elsewhere");
  if (action === "destroy") closing = pane.destroy();
  release(session); await opening; await closing; await settle();
  expect(pane.expandedPaths.size).toBe(0);
  expect(pane.peekWatchSnapshot()).toEqual([]);
  expect(loads).not.toContain(a.path);
});

it("captures navigation focus before loading and completes only the current request", async () => {
  const pane = create();
  const outcomes: string[] = [];
  let resolveFirst!: (result: DirectoryListingResult) => void;
  source.current = path => path === "/first" ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ ok: true, path, entries: [] });
  let serial = 0;
  pane.onNavigationFocus = () => {
    const id = ++serial; outcomes.push(`capture ${id}`);
    return { complete: () => outcomes.push(`complete ${id}`), cancel: () => outcomes.push(`cancel ${id}`) };
  };
  const first = pane.initialLoad("/first");
  expect(outcomes).toEqual(["capture 1"]);
  await pane.initialLoad("/second");
  resolveFirst({ ok: true, path: "/first", entries: [] }); await first;
  expect(outcomes.filter(event => event.startsWith("complete"))).toEqual(["complete 2"]);
  expect(outcomes).toContain("cancel 1");
});
it.each(["unbind", "destroy", "error"])("retires a late-mounted navigation focus request on %s", async action => {
  const pane = create();
  let resolve!: (result: DirectoryListingResult) => void;
  source.current = () => new Promise(done => { resolve = done; });
  const pending = pane.initialLoad("/next");
  const complete = vi.fn(), cancel = vi.fn();
  pane.onNavigationFocus = () => ({ complete, cancel });
  if (action === "unbind") pane.onNavigationFocus = null;
  const closing = action === "destroy" ? pane.destroy() : undefined;
  resolve(action === "error" ? { ok: false, error: "denied" } : { ok: true, path: "/next", entries: [] });
  await pending; await closing;
  expect(cancel).toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it("does not recapture newer focus when a pending navigation pane remounts", async () => {
  const pane = create();
  let resolve!: (result: DirectoryListingResult) => void;
  source.current = () => new Promise(done => { resolve = done; });
  const pending = pane.initialLoad("/next");
  const complete = vi.fn(), cancel = vi.fn(), replacement = vi.fn(() => ({ complete, cancel }));
  pane.onNavigationFocus = () => ({ complete, cancel });
  pane.onNavigationFocus = null;
  pane.onNavigationFocus = replacement;
  resolve({ ok: true, path: "/next", entries: [] }); await pending;
  expect(replacement).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});
it("keeps a user's seeded-list selection when initial navigation publishes", async () => {
  const pane = create();
  let resolve!: (result: DirectoryListingResult) => void;
  source.current = () => new Promise(done => { resolve = done; });
  const pending = pane.initialLoad("/r");
  pane.selectEntry(b);
  resolve({ ok: true, path: "/r", entries: [a, b] }); await pending;
  expect([...pane.selectedPaths]).toEqual([b.path]);
  expect(pane.focusedEntry?.path).toBe(b.path);
});
it("keeps root selections hidden by presentation filters during a seeded load", async () => {
  settingsStore.update({ showHidden: true });
  const hidden = entry("/r/.hidden", "file"), pane = create([a, b, hidden]);
  flushSync();
  let resolve!: (result: DirectoryListingResult) => void;
  source.current = () => new Promise(done => { resolve = done; });
  const pending = pane.initialLoad("/r");
  pane.selectEntry(hidden); settingsStore.update({ showHidden: false }); pane.setSorting("size"); flushSync();
  expect([...pane.selectedPaths]).toEqual([hidden.path]);
  expect(pane.displayEntries).not.toContain(hidden);
  resolve({ ok: true, path: "/r", entries: [a, b, hidden] }); await pending;
  expect([...pane.selectedPaths]).toEqual([hidden.path]);
  expect(pane.state.cursorPath).toBe(hidden.path);
});
