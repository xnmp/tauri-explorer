/** Peeks beyond the 16 native leases have no change notifications. An
 * ordinary (non-explicit) pane refresh is their only freshness path, so it
 * must reach them through refresh-manager without re-reading watched peeks. */
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
const folders = Array.from({ length: 17 }, (_, i) => entry(`/r/f${String(i).padStart(2, "0")}`));
let trees: Record<string, FileEntry[]>;
let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
function create(): ExplorerInstance {
  let pane!: ExplorerInstance;
  effects.push(client.effect_root(() => {
    pane = createExplorerState({ currentPath: "/r", entries: folders, sortBy: "name", sortAscending: true, viewMode: "details" });
    client.render_effect(() => { pane.displayEntries; pane.detailRows; });
  }));
  panes.push(pane);
  return pane;
}
async function settle(ms = 0) { for (let i = 0; i < 5; i++) { flushSync(); await vi.advanceTimersByTimeAsync(0); } await vi.advanceTimersByTimeAsync(ms); flushSync(); }

beforeEach(async () => {
  createExplorerState = await compileExplorer();
  vi.useFakeTimers(); vi.setSystemTime(30_000); cancelPendingRefreshes(); loads.length = 0;
  trees = { "/r": folders, ...Object.fromEntries(folders.map(folder => [folder.path, []])) };
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers();
  effects.splice(0).forEach(dispose => dispose());
});

it("an ordinary pane refresh reaches the unwatched overflow peek only", async () => {
  const pane = create();
  for (const folder of folders) { await pane.togglePeek(folder.path); await settle(); }
  const slots = pane.peekWatchSnapshot();
  expect(slots.filter(slot => slot.lease)).toHaveLength(16);
  expect(slots.find(slot => slot.path === folders[0].path)?.lease).toBeNull();
  const fresh = entry(`${folders[0].path}/fresh.txt`, "file");
  trees[folders[0].path] = [fresh];
  trees[folders[1].path] = [entry(`${folders[1].path}/unnotified.txt`, "file")];
  loads.length = 0;
  await pane.refresh({ silent: true }); await settle(2_500);
  expect(loads.sort()).toEqual(["/r", folders[0].path]);
  expect(pane.displayEntries).toContainEqual(fresh);
  // A watched peek relies on its own notifications, not on the fan-out.
  expect(pane.displayEntries.map(e => e.path)).not.toContain(`${folders[1].path}/unnotified.txt`);
});
