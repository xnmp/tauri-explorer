import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source, loads, cleanups } = vi.hoisted(() => ({
  source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) },
  loads: [] as string[], cleanups: { count: 0 },
}));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({
  load: (path: string) => { loads.push(path); return source.current(path); },
  cleanup: async () => { cleanups.count++; },
}) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { compileExplorer, compileSettings } from "./folder-peek-harness";

// Spring-loaded peeks (#1242): temporary peeks a live drag opens. They render
// and load like expanded folders but never enter the expanded set or heights.
const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const a = entry("/r/a"), b = entry("/r/b"), note = entry("/r/note.txt", "file");
const child = entry("/r/a/child.txt", "file"), nested = entry("/r/a/nested"), deep = entry("/r/a/nested/deep.txt", "file");
const trees: Record<string, FileEntry[]> = { "/r": [a, b, note], [a.path]: [child, nested], [nested.path]: [deep], [b.path]: [], "/other": [] };

let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
let settingsStore: Awaited<ReturnType<typeof compileSettings>>;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
function create(viewMode: "details" | "list" | "tiles" = "details"): ExplorerInstance {
  let pane!: ExplorerInstance;
  effects.push(client.effect_root(() => {
    pane = createExplorerState({ currentPath: "/r", entries: [a, b, note], sortBy: "name", sortAscending: true, viewMode });
    client.render_effect(() => { pane.displayEntries; pane.detailRows; });
  }));
  panes.push(pane);
  return pane;
}
async function settle() { for (let i = 0; i < 3; i++) { client.flush(); await vi.advanceTimersByTimeAsync(0); } client.flush(); }
const rows = (pane: ExplorerInstance) => pane.detailRows.rows.map(row => row.kind === "entry" ? `${row.depth}:${row.entry.name}${row.expanded ? "+" : ""}` : row.kind === "peek-state" ? `state:${row.message}` : row.kind);

beforeEach(async () => {
  settingsStore = await compileSettings();
  createExplorerState = await compileExplorer({ "./settings.svelte": { settingsStore } });
  vi.useFakeTimers(); settingsStore.reset(); loads.length = 0; cleanups.count = 0;
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers(); settingsStore.reset();
  effects.splice(0).forEach(dispose => dispose());
});

it("a temporary peek renders and loads like an expanded folder, and the expanded set never changes", async () => {
  const pane = create();
  pane.setSpringPeeks([a.path]); await settle();
  expect(pane.springPeeks).toEqual([a.path]);
  expect(loads).toContain(a.path);
  expect(rows(pane)).toEqual(["0:a+", "1:nested", "1:child.txt", "0:b", "0:note.txt"]);
  expect(pane.displayEntries.map(e => e.name)).toEqual(["a", "nested", "child.txt", "b", "note.txt"]);
  expect([...pane.expandedPaths]).toEqual([]);
  expect(pane.isPeekExpanded(a.path)).toBe(false);
  // Its first publication is a temporary change, which renderers animate without revealing.
  expect(pane.peekChange).toMatchObject({ path: a.path, temporary: true });

  pane.setSpringPeeks([]); await settle();
  expect(rows(pane)).toEqual(["0:a", "0:b", "0:note.txt"]);
  expect([...pane.expandedPaths]).toEqual([]);
  expect(pane.peekStatus(a.path)).toBeUndefined();
  expect(cleanups.count).toBeGreaterThan(0);
});

it("an empty folder's temporary peek shows its Empty row; nesting opens inside, and closing the outer closes both", async () => {
  const pane = create();
  pane.setSpringPeeks([b.path]); await settle();
  expect(rows(pane)).toEqual(["0:a", "0:b+", "state:Empty folder", "0:note.txt"]);
  pane.setSpringPeeks([a.path]); await settle();
  pane.setSpringPeeks([a.path, nested.path]); await settle();
  expect(rows(pane)).toEqual(["0:a+", "1:nested+", "2:deep.txt", "1:child.txt", "0:b", "0:note.txt"]);
  pane.setSpringPeeks([]); await settle();
  expect(rows(pane)).toEqual(["0:a", "0:b", "0:note.txt"]);
});

it("opening and closing temporary peeks leaves the selection, the anchor and the cursor alone", async () => {
  const pane = create();
  pane.selectPaths([note.path, b.path], note.path);
  const cursor = pane.focusedEntry?.path;
  pane.setSpringPeeks([a.path]); await settle();
  pane.setSpringPeeks([a.path, nested.path]); await settle();
  pane.setSpringPeeks([]); await settle();
  expect([...pane.selectedPaths].sort()).toEqual([b.path, note.path]);
  expect(pane.focusedEntry?.path).toBe(cursor);
});

it("never stores a card height, panel height or panel side for a temporary peek", async () => {
  const pane = create("list");
  pane.setSpringPeeks([a.path]); await settle();
  pane.setListCardRows(a.path, 3);
  pane.setTilePanelHeight(a.path, 240);
  expect(pane.listCardRows(a.path)).toBeUndefined();
  expect(pane.tilePanelHeight(a.path)).toBeUndefined();
  const tiles = create("tiles");
  tiles.setSpringPeeks([a.path]); await settle();
  tiles.rememberTilePanelSides(new Map([[a.path, "above" as const]]));
  expect(tiles.tilePanelSides.has(a.path)).toBe(false);
  pane.setSpringPeeks([]); await settle();
  // An ordinary card still remembers its height.
  await pane.togglePeek(a.path); await settle();
  pane.setListCardRows(a.path, 3);
  expect(pane.listCardRows(a.path)).toBe(3);
});

it("admits only visible, closed, plain directories; Tiles springs top-level folders only", async () => {
  const pane = create();
  await pane.togglePeek(b.path); await settle();
  // A user-expanded folder is not re-opened temporarily; files and invisible folders are refused.
  pane.setSpringPeeks([b.path, note.path, nested.path, "trash://x"]); await settle();
  expect(pane.springPeeks).toEqual([]);
  await pane.togglePeek(b.path); await settle();

  const tiles = create("tiles");
  tiles.setSpringPeeks([a.path]); await settle();
  tiles.setSpringPeeks([a.path, nested.path]); await settle();
  expect(tiles.springPeeks).toEqual([a.path]);
  expect(tiles.detailRows.rows.filter(row => row.kind === "entry" && row.expanded).map(row => row.kind === "entry" && row.entry.name)).toEqual(["a"]);
});

it("Folder Peek off gives no temporary peeks", async () => {
  settingsStore.update({ folderPeek: false }); await settle();
  const pane = create();
  pane.setSpringPeeks([a.path]); await settle();
  expect(pane.springPeeks).toEqual([]);
  expect(rows(pane)).toEqual(["0:a", "0:b", "0:note.txt"]);
});

it("navigating away drops temporary peeks; coming back shows the folder closed", async () => {
  const pane = create();
  pane.setSpringPeeks([a.path]); await settle();
  const request = pane.springRequest;
  await pane.navigateTo("/other", { autoEnterSingleSubdir: false }); await settle();
  expect(pane.springPeeks).toEqual([]);
  // A new request identity: the spring driver forgets what it had applied here.
  expect(pane.springRequest).not.toBe(request);
  expect(pane.springRequest).toEqual([]);
  await pane.navigateTo("/r", { autoEnterSingleSubdir: false }); await settle();
  expect(rows(pane)).toEqual(["0:a", "0:b", "0:note.txt"]);
});

it("a request made before the lazy peek session loads applies once it has, and only the latest request", async () => {
  const pane = create();
  pane.setSpringPeeks([a.path]);
  pane.setSpringPeeks([]);
  pane.setSpringPeeks([b.path]);
  await settle();
  expect(pane.springPeeks).toEqual([b.path]);
});

it("rows inside a temporary peek drop into their own folder; rows outside keep their ordinary behaviour", async () => {
  const pane = create();
  expect(pane.springDropFolder(child.path, "file")).toBeNull();
  pane.setSpringPeeks([a.path]); await settle();
  expect(pane.springDropFolder(child.path, "file")).toBe(a.path);
  expect(pane.springDropFolder(note.path, "file")).toBeNull();
  expect(pane.springDropFolder("/r/a/missing.txt", "file")).toBeNull();
  // A user-expanded folder nested in the temporary peek: its rows go to it.
  await pane.togglePeek(nested.path); await settle();
  expect(pane.springDropFolder(deep.path, "file")).toBe(nested.path);
  expect(pane.springDropFolder(nested.path, "state")).toBe(nested.path);
  // A directory row's wrapper (its pixel-snapped edge) drops into that directory.
  expect(pane.springDropFolder(nested.path, "directory")).toBe(nested.path);
  expect(pane.springDropFolder(a.path, "directory")).toBe(a.path);
  expect(pane.springDropFolder(b.path, "directory")).toBeNull();
  // An ordinary peek's file rows stay non-targets.
  pane.setSpringPeeks([]); await settle();
  await pane.togglePeek(a.path); await settle();
  expect(pane.springDropFolder(child.path, "file")).toBeNull();
});
