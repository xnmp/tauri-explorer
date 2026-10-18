import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "svelte/internal/client";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
const { source, loads } = vi.hoisted(() => ({ source: { current: async (_path: string): Promise<DirectoryListingResult> => ({ ok: false, error: "unset" }) }, loads: [] as string[] }));
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({ load: (path: string) => { loads.push(path); return source.current(path); }, cleanup: async () => {} }) }));
vi.mock("$lib/api/files", async original => ({ ...await original<typeof import("$lib/api/files")>(), watchDirectory: async (path: string) => ({ id: crypto.randomUUID(), path }), unwatchDirectory: async () => {} }));
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";
import { compileExplorer, compileSettings } from "./folder-peek-harness";

const flushSync = () => client.flush();
const entry = (path: string, kind: FileEntry["kind"] = "directory"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const a = entry("/r/a"), b = entry("/r/b"), child = entry("/r/a/child", "file"), nested = entry("/r/a/nested"), deep = entry("/r/a/nested/deep", "file");
const trees: Record<string, FileEntry[]> = { "/r": [a, b], [a.path]: [child, nested], [nested.path]: [deep], [b.path]: [] };

/** Counts Git badge ownership the peek session takes for its listings. */
const tracked = new Map<string, number>();
const gitStatusStore = {
  trackDirectory(path: string) {
    tracked.set(path, (tracked.get(path) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = tracked.get(path)! - 1;
      if (remaining) tracked.set(path, remaining); else tracked.delete(path);
    };
  },
  fetchForDirectory: async () => {},
  refreshDirectory: async () => {},
  invalidateDirectories: () => {},
};

let createExplorerState: typeof import("$lib/state/explorer.svelte").createExplorerState;
// A client-compiled store, so a setting change reaches Explorer's deriveds live.
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
async function settle(ms = 0) { flushSync(); await vi.advanceTimersByTimeAsync(ms); flushSync(); }
const rows = (pane: ExplorerInstance) => pane.detailRows.rows.map(row => row.kind === "entry" ? `${row.depth}:${row.entry.path}${row.expanded ? "+" : ""}` : row.kind);

beforeEach(async () => {
  settingsStore = await compileSettings();
  createExplorerState = await compileExplorer({ "./git-status.svelte": { gitStatusStore }, "./settings.svelte": { settingsStore } });
  vi.useFakeTimers(); loads.length = 0; tracked.clear(); settingsStore.reset();
  // Badges on, so "no Git ownership while off" is attributable to Folder Peek.
  settingsStore.update({ showGitStatus: true });
  source.current = async path => ({ ok: true, path, entries: trees[path] ?? [] });
});
afterEach(async () => {
  await Promise.all(panes.splice(0).map(pane => pane.destroy()));
  cancelPendingRefreshes(); vi.useRealTimers(); settingsStore.reset();
  effects.splice(0).forEach(dispose => dispose());
});

it("Folder Peek off is the classic flat Details view and keeps no peek resources", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await settle();
  await pane.togglePeek(nested.path); await settle();
  expect(rows(pane)).toEqual(["0:/r/a+", "1:/r/a/nested+", "2:/r/a/nested/deep", "1:/r/a/child", "0:/r/b"]);
  pane.selectPaths([child.path, b.path], child.path);
  expect(tracked.size).toBe(2);

  settingsStore.update({ folderPeek: false }); await settle();
  expect(pane.peekEnabled).toBe(false);
  expect(pane.displayEntries).toEqual([a, b]);
  expect(rows(pane)).toEqual(["0:/r/a", "0:/r/b"]);
  // Hidden selected children are pruned and the cursor returns to the folder.
  expect([...pane.selectedPaths]).toEqual([b.path]);
  expect(pane.focusedEntry?.path).toBe(a.path);
  expect(pane.state.selectionAnchorPath).toBeNull();
  // No listings, watches or Git ownership survive, now or after timers run.
  loads.length = 0;
  await settle(5000);
  expect(loads).toEqual([]);
  expect(pane.peekWatchSnapshot()).toEqual([]);
  expect(tracked.size).toBe(0);
  // Palette commands and Escape are the classic ones.
  expect(pane.peekCommandTarget).toBeNull();
  expect(pane.canEscapePeek).toBe(false);
  pane.escapeSelectionOrPeek();
  expect([...pane.selectedPaths]).toEqual([]);
  expect(pane.expandedPaths).toEqual(new Set([a.path, nested.path]));
  // Nothing can expand while off; remembered membership is untouched.
  await pane.togglePeek(b.path); await settle();
  expect(pane.expandedPaths).toEqual(new Set([a.path, nested.path]));
  expect(loads).toEqual([]);
});

it("turning Folder Peek back on restores the remembered expansions live", async () => {
  const pane = create();
  await pane.togglePeek(a.path); await settle();
  await pane.togglePeek(nested.path); await settle();
  settingsStore.update({ folderPeek: false }); await settle();
  expect(rows(pane)).toEqual(["0:/r/a", "0:/r/b"]);

  settingsStore.update({ folderPeek: true }); await settle();
  expect(pane.peekEnabled).toBe(true);
  expect(rows(pane)).toEqual(["0:/r/a+", "1:/r/a/nested+", "2:/r/a/nested/deep", "1:/r/a/child", "0:/r/b"]);
  expect(pane.peekWatchSnapshot().map(slot => slot.path).sort()).toEqual([a.path, nested.path]);
  expect(tracked.size).toBe(2);
});

it("a pane opened while Folder Peek is off never loads the peek session", async () => {
  settingsStore.update({ folderPeek: false });
  const pane = create(); await settle();
  await pane.togglePeek(a.path); await settle();
  expect(pane.expandedPaths.size).toBe(0);
  expect(loads).toEqual([]);
  expect(rows(pane)).toEqual(["0:/r/a", "0:/r/b"]);
});

it("with carets hidden a plain row click toggles through the Explorer action and only selects the clicked row", async () => {
  settingsStore.update({ folderPeekCarets: false });
  const pane = create();
  const plain = { ctrlKey: false, shiftKey: false, metaKey: false, altKey: false };
  pane.selectEntry(a);
  await pane.toggleOnRowClick(a, plain, false); await settle();
  expect(rows(pane)).toEqual(["0:/r/a+", "1:/r/a/nested", "1:/r/a/child", "0:/r/b"]);
  expect([...pane.selectedPaths]).toEqual([a.path]);
  // A nested folder at depth 1 toggles too; selection stays the normal click's.
  pane.selectEntry(nested);
  await pane.toggleOnRowClick(nested, plain, false); await settle();
  expect(rows(pane)).toContain("2:/r/a/nested/deep");
  expect([...pane.selectedPaths]).toEqual([nested.path]);
  // Modifier, file and drag-ending clicks never toggle.
  await pane.toggleOnRowClick(nested, { ...plain, ctrlKey: true }, false); await settle();
  await pane.toggleOnRowClick(child, plain, false); await settle();
  await pane.toggleOnRowClick(nested, plain, true); await settle();
  expect(pane.expandedPaths).toEqual(new Set([a.path, nested.path]));
  // A second plain click collapses.
  await pane.toggleOnRowClick(a, plain, false); await settle();
  expect(rows(pane)).toEqual(["0:/r/a", "0:/r/b"]);
});

it("with carets shown a row click never toggles, and with Folder Peek off nothing does", async () => {
  const plain = { ctrlKey: false, shiftKey: false, metaKey: false, altKey: false };
  const pane = create();
  expect(pane.peekCaretsShown).toBe(true);
  await pane.toggleOnRowClick(a, plain, false); await settle();
  expect(pane.expandedPaths.size).toBe(0);
  settingsStore.update({ folderPeekCarets: false, folderPeek: false }); await settle();
  expect(pane.peekCaretsShown).toBe(false);
  await pane.toggleOnRowClick(a, plain, false); await settle();
  expect(pane.expandedPaths.size).toBe(0);
});

it("a folder's double-click is refused exactly where its click toggles the peek (#1298)", async () => {
  const pane = create();
  expect(pane.rowClickOwnsPeek(a)).toBe(false);
  settingsStore.update({ folderPeekCarets: false }); await settle();
  expect(pane.rowClickOwnsPeek(a)).toBe(true);
  expect(pane.rowClickOwnsPeek(nested)).toBe(true);
  expect(pane.rowClickOwnsPeek(child)).toBe(false);
  // Tiles always draws carets, and Folder Peek off leaves no peek to toggle.
  pane.setViewMode("tiles"); await settle();
  expect(pane.rowClickOwnsPeek(a)).toBe(false);
  pane.setViewMode("list"); await settle();
  expect(pane.rowClickOwnsPeek(a)).toBe(true);
  settingsStore.update({ folderPeek: false }); await settle();
  expect(pane.rowClickOwnsPeek(a)).toBe(false);
});

it("toggling the carets option applies live", async () => {
  const pane = create();
  expect(pane.peekCaretsShown).toBe(true);
  settingsStore.update({ folderPeekCarets: false }); await settle();
  expect(pane.peekCaretsShown).toBe(false);
});
