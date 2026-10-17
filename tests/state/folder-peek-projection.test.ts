/** A root filter keystroke or one peek's publish must not re-sort, re-filter
 * or re-key unrelated peek levels (a 10k-child level cost ~35ms per pass). */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import * as fileDomain from "$lib/domain/file";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) } }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => source.current(path), cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { compileExplorer } from "./folder-peek-harness";

const flushSync = () => client.flush();
const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const large = entry("/r/large"), small = entry("/r/small");
const largeChildren = Array.from({ length: 10_000 }, (_, i) => entry(`/r/large/item-${String(i).padStart(5, "0")}`, "file"));
let trees: Record<string, FileEntry[]>;

/** Sorts per parent directory, as Explorer projects each level. */
const sorted = new Map<string, number>();
const countingFile = {
  ...fileDomain,
  sortEntries: (entries: readonly FileEntry[], ...rest: [fileDomain.SortField?, boolean?]) => {
    const parent = entries[0]?.path.slice(0, entries[0].path.lastIndexOf("/"));
    if (parent) sorted.set(parent, (sorted.get(parent) ?? 0) + 1);
    return fileDomain.sortEntries(entries, ...rest);
  },
};

let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
function create(): ExplorerInstance {
  let pane!: ExplorerInstance;
  effects.push(client.effect_root(() => {
    pane = createExplorerState({ currentPath: "/r", entries: [large, small], sortBy: "name", sortAscending: true, viewMode: "details" });
    client.render_effect(() => { pane.displayEntries; pane.detailRows; });
  }));
  panes.push(pane);
  return pane;
}
async function settle() { for (let i = 0; i < 5; i++) { flushSync(); await vi.advanceTimersByTimeAsync(0); } flushSync(); }

beforeEach(async () => {
  createExplorerState = await compileExplorer({ "$lib/domain/file": countingFile });
  vi.useFakeTimers(); cancelPendingRefreshes(); sorted.clear();
  trees = { "/r": [large, small], [large.path]: largeChildren, [small.path]: [entry("/r/small/one", "file")] };
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers();
  effects.splice(0).forEach(dispose => dispose());
});

it("root filter keystrokes re-project only the root level", async () => {
  const pane = create();
  await pane.togglePeek(large.path); await settle();
  await pane.togglePeek(small.path); await settle();
  expect(pane.displayEntries).toHaveLength(10_003);
  sorted.clear();
  for (const query of ["l", "la", "lar", "larg"]) { pane.setFilter(query); flushSync(); }
  expect(pane.displayEntries).toHaveLength(10_001);
  expect(sorted.get(large.path) ?? 0).toBe(0);
  expect(sorted.get("/r") ?? 0).toBe(4);
});

it("one peek's publish re-projects only that peek", async () => {
  const pane = create();
  await pane.togglePeek(large.path); await settle();
  await pane.togglePeek(small.path); await settle();
  sorted.clear();
  trees[small.path] = [entry("/r/small/one", "file"), entry("/r/small/two", "file")];
  await pane.refresh({ silent: true, explicit: true }, small.path); await settle();
  expect(pane.displayEntries.map(e => e.path)).toContain("/r/small/two");
  expect(sorted.get(large.path) ?? 0).toBe(0);
  expect(sorted.get(small.path)).toBe(1);
});
