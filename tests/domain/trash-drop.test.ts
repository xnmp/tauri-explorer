import { describe, expect, it } from "vitest";
import { routeTrashDrop, trashDragIds, trashDragNames, trashEntryId } from "$lib/domain/trash-drop";
import { html5DragUriList, html5TransferMatchesGesture, isPrivateDragSource } from "$lib/domain/file-drop";
import { getBookmarkDropHint } from "$lib/domain/bookmark-drop-feedback";
import { trashEntryPath } from "$lib/domain/trash";

const one = { path: trashEntryPath("a1"), name: "report.txt", kind: "file" };
const many = { path: trashEntryPath("a1"), name: "report.txt", kind: "file", paths: [trashEntryPath("a1"), trashEntryPath("b2")] };

describe("trashDragIds (#1554)", () => {
  it("reads opaque IDs from Trash entry paths only", () => {
    expect(trashEntryId("trash://a1")).toBe("a1");
    expect(trashEntryId("trash://")).toBeNull();
    expect(trashEntryId("trash://a/b")).toBeNull();
    expect(trashEntryId("/home/user/a1")).toBeNull();
    expect(trashDragIds(one)).toEqual(["a1"]);
    expect(trashDragIds(many)).toEqual(["a1", "b2"]);
  });

  it("ignores ordinary drags and refuses mixed ones", () => {
    expect(trashDragIds({ path: "/home/user/a.txt" })).toBeNull();
    expect(trashDragIds({ path: "/a", paths: ["/a", "/b"] })).toBeNull();
    expect(trashDragIds(null)).toBeNull();
    expect(trashDragIds({ path: "trash://a1", paths: ["trash://a1", "/home/user/b"] })).toEqual([]);
  });

  it("names the primary row by ID for outcome messages", () => {
    expect(trashDragNames(many)).toEqual(new Map([["a1", "report.txt"]]));
    expect(trashDragNames({ path: "/home/user/a.txt", name: "a.txt" })).toEqual(new Map());
  });
});

describe("routeTrashDrop (#1554)", () => {
  it("is not consulted for ordinary file drags", () => {
    expect(routeTrashDrop({ path: "/home/user/a.txt" }, { type: "folder", path: "/home/user/docs" }, undefined)).toBeNull();
  });

  it("restores into folders, tabs and bookmarks — never a move by path", () => {
    for (const type of ["folder", "tab", "bookmark"]) {
      expect(routeTrashDrop(many, { type, path: "/home/user/docs" }, "/home/user"))
        .toEqual({ kind: "restore", ids: ["a1", "b2"], destination: "/home/user/docs" });
    }
  });

  it("restores a trashed folder into a bookmark instead of pinning it", () => {
    const folder = { ...one, kind: "directory" };
    expect(routeTrashDrop(folder, { type: "bookmark", path: "/home/user/Pictures" }, undefined))
      .toEqual({ kind: "restore", ids: ["a1"], destination: "/home/user/Pictures" });
    expect(routeTrashDrop(folder, { type: "sidebar" }, undefined))
      .toEqual({ kind: "refuse", message: expect.stringContaining("folder or bookmark") });
  });

  it("restores into a pane background's folder, falling back to the pane path", () => {
    expect(routeTrashDrop(one, { type: "background", path: "/srv/share" }, "/home/user"))
      .toEqual({ kind: "restore", ids: ["a1"], destination: "/srv/share" });
    expect(routeTrashDrop(one, { type: "background", path: "" }, "/home/user"))
      .toEqual({ kind: "restore", ids: ["a1"], destination: "/home/user" });
    expect(routeTrashDrop(one, { type: "background", path: "" }, "C:\\Users\\me"))
      .toEqual({ kind: "restore", ids: ["a1"], destination: "C:\\Users\\me" });
  });

  it("consumes drops that cannot restore without any effect", () => {
    // Back into the Trash itself, or onto a trashed folder row.
    expect(routeTrashDrop(one, { type: "background", path: "" }, "trash://")).toEqual({ kind: "refuse", message: null });
    expect(routeTrashDrop(one, { type: "folder", path: "trash://b2" }, undefined)).toEqual({ kind: "refuse", message: null });
    expect(routeTrashDrop(one, { type: "terminal" }, undefined))
      .toEqual({ kind: "refuse", message: expect.stringContaining("no file path") });
    expect(routeTrashDrop(one, { type: "plugin" }, undefined)).toEqual({ kind: "refuse", message: null });
    expect(routeTrashDrop(one, null, "/home/user")).toEqual({ kind: "refuse", message: null });
    const mixed = { path: "trash://a1", paths: ["trash://a1", "/home/user/b"] };
    expect(routeTrashDrop(mixed, { type: "folder", path: "/home/user/docs" }, undefined)).toEqual({ kind: "refuse", message: null });
  });
});

describe("Trash drags never export a filesystem object (#1554)", () => {
  it("carries a session URN instead of file URIs", () => {
    const source = { ...many, sessionId: "s-1", nativeCopyPolicy: "move" as const };
    expect(isPrivateDragSource(source)).toBe(true);
    expect(html5DragUriList(source)).toBe("urn:tauri-explorer:drag:s-1");
    const data = { getData: (type: string) => type === "text/uri-list" ? "urn:tauri-explorer:drag:s-1" : "" };
    expect(html5TransferMatchesGesture(data, source)).toBe(true);
    expect(isPrivateDragSource({ path: "/home/user/a.txt", nativeCopyPolicy: "move" })).toBe(false);
    expect(html5DragUriList({ path: "/home/user/a.txt", sessionId: "s-2", nativeCopyPolicy: "move" })).toBe("file:///home/user/a.txt");
  });

  it("describes Bookmarks drops as restores, never pins", () => {
    expect(getBookmarkDropHint("directory", true, true)).toBe("Restore to bookmark");
    expect(getBookmarkDropHint("directory", false, true)).toBe("Drop on a bookmark to restore");
    expect(getBookmarkDropHint("directory", true)).toBe("Drop to pin");
  });
});
