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
  const shown = file("shown.txt");
  const other = file("other.txt");

  it("shows the single selected entry, whatever was shown before", () => {
    expect(previewFileFor([other], false, shown)).toBe(other);
    expect(previewFileFor([other], true, shown)).toBe(other);
    expect(previewFileFor([other], true, null)).toBe(other);
  });

  it("keeps the shown file while the pane awaits its first listing with nothing selected", () => {
    expect(previewFileFor([], true, shown)).toBe(shown);
  });

  it("has nothing to keep when nothing was shown yet", () => {
    expect(previewFileFor([], true, null)).toBeNull();
  });

  it("empties once the pane has a listing and nothing is selected", () => {
    expect(previewFileFor([], false, shown)).toBeNull();
  });

  it("previews nothing for a multi-selection, even while awaiting a listing", () => {
    expect(previewFileFor([shown, other], true, shown)).toBeNull();
    expect(previewFileFor([shown, other], false, shown)).toBeNull();
  });

  it("handles a huge selection without previewing", () => {
    const many = Array.from({ length: 100_000 }, (_, i) => file(`f${i}`));
    expect(previewFileFor(many, true, shown)).toBeNull();
  });
});
