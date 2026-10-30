/**
 * Row thumbnails in Details and List (#1465): row-height selection, which
 * entries request a thumbnail, and the column-flow List slot height.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import {
  DETAILS_THUMBNAIL_ROW_HEIGHT,
  LIST_ROW_HEIGHT,
  LIST_THUMBNAIL_ROW_HEIGHT,
  ROW_THUMBNAIL_GEN_SIZE,
  ROW_THUMBNAIL_QUALITY,
  ROW_THUMBNAIL_SIZE,
  detailsRowHeight,
  listRowHeight,
  rowThumbnailKind,
} from "$lib/domain/row-thumbnails";
import { LIST_SLOT_HEIGHT, listRows, setListSlotHeight } from "$lib/domain/list-column-flow";
import { THUMBNAIL_SIZE_CONFIG } from "$lib/domain/tile-layout";

const entry = (name: string, kind: FileEntry["kind"] = "file"): FileEntry => ({
  name, path: `/p/${name}`, kind, size: 1, modified: "2024-01-01T00:00:00Z",
});

describe("row heights", () => {
  it("fit a 48px thumbnail with the rows' existing padding and borders", () => {
    expect(ROW_THUMBNAIL_SIZE).toBe(48);
    expect(DETAILS_THUMBNAIL_ROW_HEIGHT).toBe(58); // 48 + 2×4 padding + 2×1 border
    expect(LIST_THUMBNAIL_ROW_HEIGHT).toBe(62); // 58px item + 4px row gap
    expect(LIST_ROW_HEIGHT).toBe(30);
  });

  it("Details keeps the layout's height when off and raises it (never lowers it) when on", () => {
    expect(detailsRowHeight(32, false)).toBe(32);
    expect(detailsRowHeight(28, false)).toBe(28);
    expect(detailsRowHeight(32, true)).toBe(58);
    expect(detailsRowHeight(28, true)).toBe(58);
    expect(detailsRowHeight(64, true)).toBe(64);
  });

  it("List switches between the classic and thumbnail slot", () => {
    expect(listRowHeight(false)).toBe(30);
    expect(listRowHeight(true)).toBe(62);
  });

  it("requests the Tiles small preset's backend size, so both views share cached thumbnails", () => {
    expect(ROW_THUMBNAIL_SIZE).toBe(THUMBNAIL_SIZE_CONFIG.small.displaySize);
    expect(ROW_THUMBNAIL_GEN_SIZE).toBe(THUMBNAIL_SIZE_CONFIG.small.genSize);
    expect(ROW_THUMBNAIL_QUALITY).toBe(THUMBNAIL_SIZE_CONFIG.small.quality);
  });
});

describe("rowThumbnailKind", () => {
  it("requests image thumbnails for raster images", () => {
    for (const name of ["a.jpg", "b.PNG", "c.webp", "d.gif", "e.avif"]) expect(rowThumbnailKind(entry(name))).toBe("image");
  });

  it("requests video frames for videos and cover art for audio", () => {
    expect(rowThumbnailKind(entry("clip.mp4"))).toBe("video");
    expect(rowThumbnailKind(entry("song.mp3"))).toBe("video");
  });

  it("keeps the icon for folders and other files", () => {
    expect(rowThumbnailKind(entry("photos.jpg", "directory"))).toBeNull();
    expect(rowThumbnailKind(entry("notes.txt"))).toBeNull();
    expect(rowThumbnailKind(entry("vector.svg"))).toBeNull();
    expect(rowThumbnailKind(entry("Makefile"))).toBeNull();
  });
});

describe("column-flow List slot height", () => {
  afterEach(() => setListSlotHeight(LIST_ROW_HEIGHT));

  it("defaults to the classic 30px slot", () => {
    expect(LIST_SLOT_HEIGHT).toBe(30);
    expect(listRows(300)).toBe(10);
  });

  it("a thumbnail slot height is read live by the flow geometry", () => {
    setListSlotHeight(listRowHeight(true));
    expect(LIST_SLOT_HEIGHT).toBe(62);
    expect(listRows(620)).toBe(10);
    // Short scrollports keep their four-slot floor.
    expect(listRows(100)).toBe(4);
  });
});
