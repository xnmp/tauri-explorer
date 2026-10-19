import { rememberListExpansion } from "$lib/domain/folder-peek-memory";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) } }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => source.current(path), cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { compileExplorer, compileSettings } from "./folder-peek-harness";

// List cards (#1240): column-flow List is a peek tree like Details.
const entry = (path: string, kind: FileEntry["kind"] = "directory", size = 1): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size, modified: "" });
const a = entry("/r/a"), b = entry("/r/b");
const big = entry("/r/a/big.txt", "file", 10), small = entry("/r/a/small.txt", "file", 900), mid = entry("/r/a/Mid.txt", "file", 50);
const trees: Record<string, FileEntry[]> = { "/r": [a, b], [a.path]: [big, small, mid], [b.path]: [] };
let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
// A client-compiled store, so the explorer reacts to live setting changes.
let settingsStore: Awaited<ReturnType<typeof compileSettings>>;
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
  settingsStore = await compileSettings();
  createExplorerState = await compileExplorer({ "./settings.svelte": { settingsStore } });
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
  // Tiles peeks top-level folders (#1241); Folder Peek off is the classic flat view.
  pane.setViewMode("tiles"); await settle();
  expect(pane.peekEnabled).toBe(true);
  expect(pane.displayEntries.map(e => e.name)).toEqual(["a", "big.txt", "Mid.txt", "small.txt", "b"]);
  settingsStore.update({ folderPeek: false }); await settle();
  expect(pane.peekEnabled).toBe(false);
  expect(pane.displayEntries).toEqual([a, b]);
});

it("records user peek toggles for renderers, but not pruning, refresh or navigation", async () => {
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
  const toggled = left.peekChange;
  left.setListCardRows(a.path, 3);
  expect(left.listCardRows(a.path)).toBe(3);
  expect(right.listCardRows(a.path)).toBeUndefined();
  // A resize is not a toggle: its preview already showed the height.
  expect(left.peekChange).toBe(toggled);
  await left.togglePeek(a.path); await left.togglePeek(a.path); await settle();
  expect(left.listCardRows(a.path)).toBe(3);
  settingsStore.update({ folderPeek: false });
  left.setListCardRows(a.path, 5);
  expect(left.listCardRows(a.path)).toBe(3);
});

it("Tiles peeks top-level folders only, always with carets (#1241)", async () => {
  const nested = entry("/r/a/nested"), deep = entry("/r/a/nested/deep", "file");
  source.current = async path => ({ ok: true, path, entries: path === a.path ? [nested, big] : path === nested.path ? [deep] : trees[path] ?? [] });
  settingsStore.update({ folderPeekCarets: false });
  const pane = create("tiles");
  expect(pane.peekEnabled).toBe(true);
  // The carets option is for Details and List: Tiles always draws its carets,
  // so a plain click selects and never toggles.
  expect(pane.peekCaretsShown).toBe(true);
  const plain = { ctrlKey: false, shiftKey: false, metaKey: false, altKey: false };
  await pane.toggleOnRowClick(a, plain, false); await settle();
  expect(pane.expandedPaths.size).toBe(0);
  await pane.togglePeek(a.path); await settle();
  expect(pane.displayEntries.map(e => e.name)).toEqual(["a", "nested", "big.txt", "b"]);
  // A panel's subfolder is a navigation target, not a nested peek: toggling it
  // records no hidden expansion and no toggle.
  const toggled = pane.peekChange;
  await pane.togglePeek(nested.path); await settle();
  expect(pane.displayEntries.map(e => e.name)).toEqual(["a", "nested", "big.txt", "b"]);
  expect([...pane.expandedPaths]).toEqual([a.path]);
  expect(pane.peekChange).toBe(toggled);
  // "Peek into Folder" on a panel's subfolder or file acts on the panel's folder,
  // as it does for a file in a Details or List peek.
  pane.selectPaths([nested.path], nested.path);
  expect(pane.peekCommandTarget).toBe(a.path);
  pane.selectPaths([big.path], big.path);
  expect(pane.peekCommandTarget).toBe(a.path);
  pane.selectPaths([a.path], a.path);
  expect(pane.peekCommandTarget).toBe(a.path);
  pane.setViewMode("list"); await settle();
  expect(pane.peekCaretsShown).toBe(false);
});

it("keeps Tiles panel sides per pane while each folder stays expanded, across navigation and view modes", async () => {
  const left = create("tiles"), right = create("tiles");
  await left.togglePeek(a.path); await left.togglePeek(b.path); await settle();
  const toggled = left.peekChange;
  left.rememberTilePanelSides(new Map([[a.path, "above"], [b.path, "below"]]));
  expect([...left.tilePanelSides]).toEqual([[a.path, "above"], [b.path, "below"]]);
  expect(right.tilePanelSides.size).toBe(0);
  expect(left.peekChange).toBe(toggled);
  // A layout that places only b (another directory, another mount) keeps a's side.
  left.rememberTilePanelSides(new Map([[b.path, "stacked"]]));
  expect([...left.tilePanelSides]).toEqual([[a.path, "above"], [b.path, "stacked"]]);
  await left.navigateTo(a.path); await settle();
  await left.navigateTo("/r"); await settle();
  left.setViewMode("details"); await settle();
  left.setViewMode("tiles"); await settle();
  expect(left.tilePanelSides.get(a.path)).toBe("above");
  // Closing a folder forgets its side (unlike its height); re-opening places it afresh.
  await left.togglePeek(a.path); await settle();
  expect([...left.tilePanelSides]).toEqual([[b.path, "stacked"]]);
  await left.togglePeek(a.path); await settle();
  expect(left.tilePanelSides.has(a.path)).toBe(false);
  // A side for a folder that is not expanded is never remembered.
  left.rememberTilePanelSides(new Map([["/r/elsewhere", "above"]]));
  expect(left.tilePanelSides.has("/r/elsewhere")).toBe(false);
  // Off is capability none: nothing is remembered.
  settingsStore.update({ folderPeek: false });
  left.rememberTilePanelSides(new Map([[b.path, "above"]]));
  expect(left.tilePanelSides.get(b.path)).toBe("stacked");
});

it("remembers Tiles panel heights per pane for the session, without counting as a toggle", async () => {
  const left = create("tiles"), right = create("tiles");
  await left.togglePeek(a.path); await right.togglePeek(a.path); await settle();
  const toggled = left.peekChange;
  expect(left.tilePanelHeight(a.path)).toBeUndefined();
  left.setTilePanelHeight(a.path, 240.4);
  expect(left.tilePanelHeight(a.path)).toBe(240);
  expect(right.tilePanelHeight(a.path)).toBeUndefined();
  expect(left.peekChange).toBe(toggled);
  // Closing and re-opening keeps the folder's height.
  await left.togglePeek(a.path); await left.togglePeek(a.path); await settle();
  expect(left.tilePanelHeight(a.path)).toBe(240);
  // Malformed heights are ignored rather than remembered.
  left.setTilePanelHeight(a.path, Number.NaN);
  left.setTilePanelHeight(a.path, -5);
  expect(left.tilePanelHeight(a.path)).toBe(240);
  settingsStore.update({ folderPeek: false });
  left.setTilePanelHeight(a.path, 400);
  expect(left.tilePanelHeight(a.path)).toBe(240);
});


it("full-flow choice is per pane and survives collapse, refresh, navigation and view changes", async () => {
  const left = create("list"), right = create("list");
  await left.togglePeek(a.path); await settle();
  left.showAllListChildren(a.path);
  expect([...left.listFullFlowPaths]).toEqual([a.path]);
  expect(right.listFullFlowPaths.size).toBe(0);
  await left.togglePeek(a.path); await left.togglePeek(a.path); await settle();
  await left.refresh({ silent: true }); await settle();
  left.setViewMode("details"); await settle();
  left.setViewMode("list"); await settle();
  await left.navigateTo(a.path); await settle();
  await left.navigateTo("/r"); await settle();
  expect(left.listFullFlowPaths.has(a.path)).toBe(true);
  expect(left.expandedPaths.has(a.path)).toBe(true);
});

it("full-flow accepts only an open, permanent top-level List folder", async () => {
  const pane = create("list");
  pane.showAllListChildren(a.path);
  expect(pane.listFullFlowPaths.size).toBe(0);
  await pane.setSpringPeeks([a.path]); await settle();
  pane.showAllListChildren(a.path);
  expect(pane.listFullFlowPaths.size).toBe(0);
  await pane.setSpringPeeks([]); await pane.togglePeek(a.path); await settle();
  pane.showAllListChildren(big.path);
  expect(pane.listFullFlowPaths.size).toBe(0);
  pane.setViewMode("details"); await settle();
  pane.showAllListChildren(a.path);
  expect(pane.listFullFlowPaths.size).toBe(0);
});


it("keeps column and full-flow stages mutually exclusive and pane-local", async () => {
  const left = create("list"), right = create("list");
  await left.togglePeek(a.path); await settle();
  left.showColumnListChildren(a.path);
  expect(left.listColumnPaths.has(a.path)).toBe(true);
  expect(left.listFullFlowPaths.has(a.path)).toBe(false);
  expect(right.listColumnPaths.size).toBe(0);
  left.showAllListChildren(a.path);
  expect(left.listColumnPaths.has(a.path)).toBe(false);
  expect(left.listFullFlowPaths.has(a.path)).toBe(true);
  left.showColumnListChildren(a.path);
  await left.togglePeek(a.path); await left.togglePeek(a.path); await settle();
  expect(left.listColumnPaths.has(a.path)).toBe(true);
  expect(left.listFullFlowPaths.has(a.path)).toBe(false);
  left.setViewMode("details"); await settle();
  left.showAllListChildren(a.path);
  expect(left.listColumnPaths.has(a.path)).toBe(true);
});

it("bounds session stages and retains the most recently chosen folders", () => {
  const before = new Map([["/r/a", "column"], ["/r/b", "full"]] as const);
  const refreshed = rememberListExpansion(before, "/r/a", "full", 2);
  expect([...rememberListExpansion(refreshed, "/r/c", "column", 2)])
    .toEqual([["/r/a", "full"], ["/r/c", "column"]]);
  expect([...before]).toEqual([["/r/a", "column"], ["/r/b", "full"]]);
  expect(rememberListExpansion(before, "/r/c", "column", 0).size).toBe(0);
  let many: ReadonlyMap<string, "column" | "full"> = new Map();
  for (let index = 0; index < 1000; index++) many = rememberListExpansion(many, `/r/${index}`, "column");
  expect(many.size).toBe(500);
  expect(many.has("/r/499")).toBe(false);
  expect(many.has("/r/999")).toBe(true);
});
