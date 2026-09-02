import { describe, expect, it } from "vitest";
import { getBookmarkDropHint } from "$lib/domain/bookmark-drop-feedback";

describe("getBookmarkDropHint", () => {
  it("shows pinning feedback for directory drops on a bookmark", () => {
    expect(getBookmarkDropHint("directory", true)).toBe("Drop to pin");
  });

  it("shows move feedback only for file drops on a bookmark", () => {
    expect(getBookmarkDropHint("file", true)).toBe("Move to bookmark");
  });

  it("does not promise a file move for an untargeted Bookmarks drop", () => {
    expect(getBookmarkDropHint("file", false)).toBe("Drop not allowed");
  });
});
