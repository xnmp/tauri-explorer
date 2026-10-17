/** Git badge fetches for peeked folders: one when a folder newly loads, then
 * one per real change. Unchanged refresh passes, a second trigger for one
 * notification, and panes with badges off never spawn `git status`. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source, gitCalls } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) }, gitCalls: [] as string[] }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => source.current(path), cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
vi.mock("$lib/api/git", async original => ({
  ...await original<typeof import("$lib/api/git")>(),
  getGitStatus: async (path: string) => { gitCalls.push(path); return { ok: true, data: { is_git_repo: true, statuses: {} } }; },
  cancelGetGitStatus: async () => {},
}));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { gitStatusStore } from "$lib/state/git-status.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { compileExplorer, compileSettings } from "./folder-peek-harness";

const flushSync = () => client.flush();
const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const a = entry("/r/a"), b = entry("/r/b");
let trees: Record<string, FileEntry[]>;
let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
let settingsStore: Awaited<ReturnType<typeof compileSettings>>;
const panes: ExplorerInstance[] = [];
const effects: (() => void)[] = [];
function create(): ExplorerInstance {
  let pane!: ExplorerInstance;
  effects.push(client.effect_root(() => {
    pane = createExplorerState({ currentPath: "/r", entries: [a, b], sortBy: "name", sortAscending: true, viewMode: "details" });
    client.render_effect(() => { pane.displayEntries; pane.detailRows; });
  }));
  panes.push(pane);
  return pane;
}
async function settle(ms = 0) { for (let i = 0; i < 5; i++) { flushSync(); await vi.advanceTimersByTimeAsync(0); } await vi.advanceTimersByTimeAsync(ms); flushSync(); }
const fetched = (path: string) => gitCalls.filter(call => call === path).length;

beforeEach(async () => {
  settingsStore = await compileSettings();
  createExplorerState = await compileExplorer({ "./settings.svelte": { settingsStore } });
  vi.useFakeTimers(); vi.setSystemTime(50_000); cancelPendingRefreshes();
  settingsStore.reset(); settingsStore.update({ showGitStatus: true });
  gitStatusStore.clear(); gitCalls.length = 0;
  trees = { "/r": [a, b], [a.path]: [entry("/r/a/one", "file")], [b.path]: [] };
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers(); settingsStore.reset();
  effects.splice(0).forEach(dispose => dispose());
});

it("a newly loaded peek fetches its badges once", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await settle();
  expect(pane.displayEntries.map(e => e.path)).toContain("/r/a/one");
  expect(fetched(a.path)).toBe(1);
});

it("an explicit refresh fetches badges only for peeks whose listing changed", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await settle();
  await pane.togglePeek(b.path); await settle();
  gitCalls.length = 0;
  await pane.refresh({ silent: true, explicit: true }); await settle();
  expect(gitCalls).toEqual([]);
  trees[b.path] = [entry("/r/b/new", "file")];
  await pane.refresh({ silent: true, explicit: true }); await settle();
  expect(gitCalls).toEqual([b.path]);
});

it("one notification fetches once, though the window watcher and the peek both see it", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await settle();
  gitCalls.length = 0;
  trees[a.path] = [entry("/r/a/one", "file"), entry("/r/a/two", "file")];
  const change = { path: a.path, observedAt: Date.now(), origin: "watcher" as const };
  // use-file-watchers' window-level directory subscription, then the pane's.
  gitStatusStore.invalidateDirectories([change.path]);
  pane.directoryChanged(change);
  await settle(2_000);
  expect(pane.displayEntries.map(e => e.path)).toContain("/r/a/two");
  expect(fetched(a.path)).toBe(1);
});

it("with badges off, peeks spawn no git status; turning them on fetches each peek once", async () => {
  settingsStore.update({ showGitStatus: false });
  const pane = create();
  await pane.togglePeek(a.path); await settle();
  trees[a.path] = [entry("/r/a/two", "file")];
  await pane.refresh({ silent: true, explicit: true }); await settle();
  expect(gitCalls).toEqual([]);
  settingsStore.update({ showGitStatus: true }); await settle();
  expect(gitCalls).toEqual([a.path]);
  settingsStore.update({ showGitStatus: false }); await settle();
  gitStatusStore.invalidateDirectories([a.path]); await settle();
  expect(gitCalls).toEqual([a.path]);
});
