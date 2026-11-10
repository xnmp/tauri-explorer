/**
 * DOM (HTML5, Linux) drops of Trash entries (#1554): folder, listing and
 * Bookmarks destinations restore the dragged IDs into a real folder, and never
 * reach the ordinary move/copy session or bookmark pinning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/state/drag-clock", async actual => ({ ...await actual<object>(), dragClock: {
  initialize: async () => {}, ready: true,
  stamp: () => ({ clockId: `browser:${performance.timeOrigin}`, at: Math.floor(performance.timeOrigin + performance.now()), uncertainty: 0 }),
} }));
vi.mock("$lib/state/trash-provider", () => ({ dropTrashEntries: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/state/drop-operations", async actual => ({
  ...await actual<object>(),
  handleFileDropMany: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/state/bookmarks.svelte", () => ({ bookmarksStore: { addBookmark: vi.fn() } }));

import { dropIntoDirectory } from "$lib/composables/use-dom-directory-drop";
import { dropOnQuickAccess } from "$lib/composables/use-sidebar-file-drop";
import { dropTrashEntries } from "$lib/state/trash-provider";
import { handleFileDropMany } from "$lib/state/drop-operations";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { dragState, type DragData } from "$lib/state/drag.svelte";
import { dropElement } from "../helpers/drop-element";

function transfer(): DataTransfer {
  const data = new Map<string, string>();
  return { getData: (type: string) => data.get(type) ?? "", setData: (type: string, value: string) => { data.set(type, value); },
    get types() { return [...data.keys()]; }, effectAllowed: "move", dropEffect: "none" } as unknown as DataTransfer;
}

/** A Trash drag as `createHtml5FileDrag` publishes it. */
function trashDrag(source: Omit<DragData, "sessionId">): DataTransfer {
  dragState.start(source);
  const live = dragState.current!;
  const data = transfer();
  data.setData("application/x-explorer-path", live.path);
  data.setData("application/x-explorer-name", live.name);
  data.setData("application/x-explorer-kind", live.kind);
  if (live.paths) data.setData("application/x-explorer-paths", JSON.stringify(live.paths));
  data.setData("application/x-explorer-session", live.sessionId!);
  dragState.bindDomSource(data, live);
  return data;
}

function drop(data: DataTransfer, target: HTMLElement): DragEvent {
  const event = Object.assign(new Event("drop", { cancelable: true }), { dataTransfer: data, clientX: 1, clientY: 1 });
  Object.defineProperty(event, "target", { value: target });
  return event as unknown as DragEvent;
}

const files = { path: "trash://a1", name: "a.txt", kind: "file", paths: ["trash://a1", "trash://b2"] };

beforeEach(() => {
  vi.mocked(dropTrashEntries).mockClear();
  vi.mocked(handleFileDropMany).mockClear();
  vi.mocked(bookmarksStore.addBookmark).mockClear();
});
afterEach(() => dragState.clear());

describe("Trash entries dropped through the DOM (#1554)", () => {
  it("restore into a folder row's directory by ID", async () => {
    const data = trashDrag(files);
    const row = dropElement("entry-item directory", { "data-path": "/home/user/docs" });
    const event = drop(data, row);
    await dropIntoDirectory(event, "/home/user/docs", "folder", { onRefresh: () => {} });
    expect(dropTrashEntries).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: "trash://a1" }), { type: "folder", path: "/home/user/docs" }, "/home/user/docs");
    expect(handleFileDropMany).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("restore into another pane's listing", async () => {
    const pane = dropElement("content", { "data-current-path": "/srv/share" });
    await dropIntoDirectory(drop(trashDrag(files), pane), "/srv/share", "listing-background", { onRefresh: () => {} });
    expect(dropTrashEntries).toHaveBeenLastCalledWith(expect.anything(), { type: "folder", path: "/srv/share" }, "/srv/share");
    expect(handleFileDropMany).not.toHaveBeenCalled();
  });

  it("restore a trashed folder into a bookmark rather than pinning it", () => {
    const data = trashDrag({ path: "trash://c3", name: "Album", kind: "directory" });
    const access = dropElement("quick-access");
    const bookmark = dropElement("bookmark-drop-target", { "data-path": "/home/user/Pictures" }, access);
    expect(dropOnQuickAccess(drop(data, bookmark))).toBe(true);
    expect(dropTrashEntries).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: "trash://c3" }), { type: "bookmark", path: "/home/user/Pictures" });
    expect(bookmarksStore.addBookmark).not.toHaveBeenCalled();
  });

  it("never pin when dropped on empty Bookmarks space", () => {
    const data = trashDrag({ path: "trash://c3", name: "Album", kind: "directory" });
    expect(dropOnQuickAccess(drop(data, dropElement("quick-access")))).toBe(true);
    expect(dropTrashEntries).toHaveBeenCalledWith(expect.objectContaining({ path: "trash://c3" }), { type: "sidebar" });
    expect(bookmarksStore.addBookmark).not.toHaveBeenCalled();
  });

  it("leave ordinary file drags on the move path", async () => {
    const data = trashDrag({ path: "/home/user/a.txt", name: "a.txt", kind: "file" });
    const row = dropElement("entry-item directory", { "data-path": "/home/user/docs" });
    await dropIntoDirectory(drop(data, row), "/home/user/docs", "folder", { onRefresh: () => {} });
    expect(dropTrashEntries).not.toHaveBeenCalled();
    expect(handleFileDropMany).toHaveBeenCalledWith(["/home/user/a.txt"], "/home/user/docs", undefined, expect.anything());
  });
});
