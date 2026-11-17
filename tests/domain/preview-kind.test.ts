import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { classifyPreview, previewFileFor, shouldHoldPreviewImage } from "$lib/domain/preview-kind";
import * as types from "$lib/domain/file-types";

const file = (name: string, kind: FileEntry["kind"] = "file"): FileEntry =>
  ({ name, path: `/${name}`, kind, size: 12, modified: "today" });

describe("preview classification", () => {
  it.each([
    ["folder.jpg", "directory", "directory"], ["a.zip", "file", "zip"],
    ["a.PDF", "file", "pdf"], ["a.mp4", "file", "video"],
    ["a.png", "file", "image"], ["a.svg", "file", "image"],
    ["a.mp3", "file", "audio-cover"], ["a.flac", "file", "audio-cover"],
    ["a.csv", "file", "csv"], ["a.md", "file", "markdown"],
    ["a.html", "file", "html"], ["a.HTM", "file", "html"],
    ["a.ts", "file", "code"], ["a.txt", "file", "text"],
    ["LICENSE", "file", "text"], ["a.exe", "file", "unsupported"],
  ] as const)("%s (%s) dispatches to %s", (name, kind, expected) => {
    expect(classifyPreview(file(name, kind))).toBe(expected);
  });

  it.each(["a.zip", "a.pdf", "a.mp4"])("%s pre-empts image detection", (name) => {
    // A future image backend may support these formats too. Their dedicated
    // viewers must still win, including in the hold-image decision.
    const image = vi.spyOn(types, "isImageFile").mockReturnValue(true);
    try {
      const kind = classifyPreview(file(name));
      expect(kind).toBe(({ "a.zip": "zip", "a.pdf": "pdf", "a.mp4": "video" })[name]);
      expect(shouldHoldPreviewImage("image", kind)).toBe(false);
    } finally { image.mockRestore(); }
  });

  it("holds decoded images only for the next image branch", () => {
    expect(shouldHoldPreviewImage("image", "image")).toBe(true);
    expect(shouldHoldPreviewImage("audio-cover", "image")).toBe(true);
    for (const next of ["directory", "zip", "pdf", "video", "audio-cover", "csv", "markdown", "code", "text", "unsupported"] as const) {
      expect(shouldHoldPreviewImage("image", next)).toBe(false);
    }
    expect(shouldHoldPreviewImage(null, "image")).toBe(false);
    expect(shouldHoldPreviewImage("text", "image")).toBe(false);
  });
});

describe("previewFileFor (#1729)", () => {
  const inDir = (name: string, dir = "/work"): FileEntry => ({ ...file(name), path: `${dir}/${name}` });
  const shown = inDir("shown.txt");
  const other = inDir("other.txt");
  const pane = (selected: FileEntry[], awaitingFirstListing: boolean, directory = "/work") =>
    ({ selected, awaitingFirstListing, directory });

  it("shows the single selected entry, whatever was shown before", () => {
    expect(previewFileFor(pane([other], false), shown)).toBe(other);
    expect(previewFileFor(pane([other], true), shown)).toBe(other);
    expect(previewFileFor(pane([other], true, "/elsewhere"), null)).toBe(other);
  });

  it("keeps the shown file while a pane of its directory awaits its first listing with nothing selected", () => {
    expect(previewFileFor(pane([], true), shown)).toBe(shown);
  });

  it("matches the directory by native equality (trailing separator, Windows case and separators)", () => {
    expect(previewFileFor(pane([], true, "/work/"), shown)).toBe(shown);
    const windows = { ...file("a.txt"), path: "C:\\Work\\a.txt" };
    expect(previewFileFor(pane([], true, "c:/work"), windows)).toBe(windows);
  });

  it("never holds a file from another directory, or before the pane knows its directory", () => {
    expect(previewFileFor(pane([], true, "/elsewhere"), shown)).toBeNull();
    expect(previewFileFor(pane([], true, "/work/sub"), shown)).toBeNull();
    expect(previewFileFor(pane([], true, ""), shown)).toBeNull();
  });

  it("has nothing to keep when nothing was shown yet", () => {
    expect(previewFileFor(pane([], true), null)).toBeNull();
  });

  it("empties once the pane has a listing and nothing is selected", () => {
    expect(previewFileFor(pane([], false), shown)).toBeNull();
  });

  it("previews nothing for a multi-selection, even while awaiting a listing", () => {
    expect(previewFileFor(pane([shown, other], true), shown)).toBeNull();
  });
});
