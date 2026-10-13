import { afterEach, expect, it, vi } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
import type { FileEntry } from "$lib/domain/file";

const { listings } = vi.hoisted(() => ({ listings: {} as Record<string, FileEntry[]> }));
vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: async (path: string) => ({ ok: true, path, entries: listings[path] ?? [] }),
    cleanup: async () => {},
  }),
}));

const managers: ReturnType<typeof createWindowTabsManager>[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.dispose())); localStorage.clear(); });
const file = (path: string): FileEntry => ({ path, name: path, kind: "file", size: 0, modified: "" });
const manager = () => {
  const value = createWindowTabsManager();
  managers.push(value);
  value.init("/home/user", true);
  return value;
};

it("combines only this window's active tab, in focused then visual pane order", async () => {
  const first = manager();
  const left = first.activePaneId;
  first.splitPane("right");
  const right = first.activePaneId;
  const a = file("/a"), b = file("/b"), duplicate = file("/same");
  const leftExplorer = first.getExplorer(left)!;
  listings["/left"] = [a, duplicate];
  await leftExplorer.navigateTo("/left");
  leftExplorer.selectAll();
  const rightExplorer = first.getExplorer(right)!;
  listings["/right"] = [b, duplicate];
  await rightExplorer.navigateTo("/right");
  rightExplorer.selectAll();
  const tabId = first.activeTabId!;
  expect(first.getCombinedSelection().map((entry) => entry.path)).toEqual(["/b", "/same", "/a"]);
  first.setActivePane(left);
  expect(first.getCombinedSelection().map((entry) => entry.path)).toEqual(["/a", "/same", "/b"]);
  rightExplorer.clearSelection();
  expect(first.getCombinedSelection().map((entry) => entry.path)).toEqual(["/a", "/same"]);
  first.createTab("/elsewhere");
  expect(first.getCombinedSelection()).toEqual([]);
  first.setActiveTab(tabId);
  expect(first.getCombinedSelection().map((entry) => entry.path)).toEqual(["/a", "/same"]);
  const secondWindow = manager();
  expect(secondWindow.getCombinedSelection()).toEqual([]);
});

it("returns no selection without an explorer tab", () => {
  const value = createWindowTabsManager();
  managers.push(value);
  expect(value.getCombinedSelection()).toEqual([]);
});
