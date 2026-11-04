/** The pane filter applies inside Folder Peek (#1510), through the real
 * explorer → facade → session → peek-filter chain. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) } }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => source.current(path), cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import * as files from "$lib/api/files";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import type { ViewMode } from "$lib/state/types";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { settingsStore } from "$lib/state/settings.svelte";
import { compileExplorer } from "./folder-peek-harness";

const flushSync = () => client.flush();
const dir = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory", size: 1, modified: "" });
const file = (path: string): FileEntry => ({ ...dir(path), kind: "file" });

// /r/photos/2024/trip/beach.jpg is 3 levels below photos; /r/archive's match is 4 below.
const photos = dir("/r/photos"), docs = dir("/r/docs"), archive = dir("/r/archive"), beachNote = file("/r/beach-notes.txt");
const year = dir("/r/photos/2024"), trip = dir("/r/photos/2024/trip"), beach = file("/r/photos/2024/trip/beach.jpg");
const misc = file("/r/photos/misc.png");
const trees: Record<string, FileEntry[]> = {
  "/r": [archive, beachNote, docs, photos],
  [photos.path]: [year, misc],
  [year.path]: [trip],
  [trip.path]: [beach, file("/r/photos/2024/trip/hotel.jpg")],
  [docs.path]: [file("/r/docs/report.pdf")],
  [archive.path]: [dir("/r/archive/a")],
  "/r/archive/a": [dir("/r/archive/a/b")],
  "/r/archive/a/b": [dir("/r/archive/a/b/c")],
  "/r/archive/a/b/c": [file("/r/archive/a/b/c/beach-old.jpg")],
};
const scanned: string[] = [];
const fetchDirectory: typeof files.fetchDirectory = async path => {
  scanned.push(path);
  return { ok: true, data: { path, entries: trees[path] ?? [] } };
};

let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
function create(viewMode: ViewMode = "details") {
  let pane!: ExplorerInstance;
  effects.push(client.effect_root(() => {
    pane = createExplorerState({ currentPath: "/r", entries: trees["/r"], sortBy: "name", sortAscending: true, viewMode });
    client.render_effect(() => { pane.displayEntries; pane.detailRows; });
  }));
  panes.push(pane);
  return pane;
}
async function settle() { for (let i = 0; i < 8; i++) { flushSync(); await vi.advanceTimersByTimeAsync(60); } flushSync(); }
const paths = (pane: ExplorerInstance) => pane.displayEntries.map(entry => entry.path);

beforeEach(async () => {
  createExplorerState = await compileExplorer({ "$lib/api/files": { ...files, fetchDirectory } });
  vi.useFakeTimers(); cancelPendingRefreshes(); settingsStore.reset(); scanned.length = 0;
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers(); settingsStore.reset();
  effects.splice(0).forEach(dispose => dispose());
});

describe("filter inside Folder Peek (#1510)", () => {
  it("keeps a non-matching folder whose descendant matches, without any peek open", async () => {
    const pane = create();
    pane.setFilter("beach"); await settle();
    // photos stays for photos/2024/trip/beach.jpg; docs has no match and the
    // archive match lies 4 levels down, past the depth bound.
    expect(paths(pane)).toEqual([photos.path, beachNote.path]);
    expect(scanned).not.toContain("/r/archive/a/b/c");
  });

  it.each<ViewMode>(["details", "list"])("shows only matches and the folders on the path to them inside the peek (%s)", async mode => {
    const pane = create(mode);
    await pane.togglePeek(photos.path); await settle();
    expect(paths(pane)).toContain(misc.path);
    pane.setFilter("beach"); await settle();
    expect(paths(pane)).toEqual([photos.path, year.path, beachNote.path]);
    await pane.togglePeek(year.path); await settle();
    await pane.togglePeek(trip.path); await settle();
    expect(paths(pane)).toEqual([photos.path, year.path, trip.path, beach.path, beachNote.path]);
    pane.clearFilter(); await settle();
    expect(paths(pane)).toContain(misc.path);
    expect(paths(pane)).toContain("/r/photos/2024/trip/hotel.jpg");
  });

  it("filters the top-level Tiles panels too", async () => {
    const pane = create("tiles");
    await pane.togglePeek(photos.path); await settle();
    pane.setFilter("beach"); await settle();
    expect(paths(pane)).toEqual([photos.path, year.path, beachNote.path]);
  });

  it("reads a name-matching folder without matching children as no matches", async () => {
    const pane = create();
    await pane.togglePeek(docs.path); await settle();
    pane.setFilter("docs"); await settle();
    expect(paths(pane)).toEqual([docs.path]);
    expect(pane.detailRows.rows.some(row => row.kind === "peek-state" && row.message === "No matching items")).toBe(true);
  });

  it("stops scanning when the filter is cleared", async () => {
    const pane = create();
    pane.setFilter("beach"); await settle();
    pane.clearFilter(); await settle();
    scanned.length = 0;
    await settle();
    expect(scanned).toEqual([]);
    expect(paths(pane)).toEqual([archive.path, docs.path, photos.path, beachNote.path]);
  });
});
