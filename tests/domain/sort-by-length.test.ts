/** Sort by Length (#1531): `sortEntries` ordering and persisted sort state. */
import { beforeEach, describe, expect, it } from "vitest";
import { isSortField, sortEntries, type FileEntry } from "$lib/domain/file";
import { normalizeDirectorySeed } from "$lib/domain/window-input";
import { getSortPref, saveSortPref } from "$lib/state/sort-prefs";

const file = (name: string): FileEntry => ({ name, path: `/r/${name}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" });
const dir = (name: string): FileEntry => ({ name, path: `/r/${name}`, kind: "directory", size: 0, modified: "2026-01-01T00:00:00Z" });
const names = (entries: readonly FileEntry[]) => entries.map((entry) => entry.name);

const LENGTHS: Record<string, number | null> = {
  "long.mp4": 3725, "short.mp4": 5, "mid.demorec": 734, "also-mid.mkv": 734,
  "unreadable.avi": null, "nan.mp4": Number.NaN, "negative.mp4": -3, "infinite.mp4": Number.POSITIVE_INFINITY,
};
const lengthOf = (entry: FileEntry) => LENGTHS[entry.name];

describe("sortEntries by length (#1531)", () => {
  const entries = [
    file("notes.txt"), file("long.mp4"), dir("Zed"), file("unreadable.avi"), file("short.mp4"),
    file("mid.demorec"), dir("Alpha"), file("also-mid.mkv"), file("nan.mp4"), file("negative.mp4"), file("infinite.mp4"),
  ];

  it("orders known lengths by seconds, ties by name, unknown and malformed after, directories first", () => {
    expect(names(sortEntries(entries, "length", true, { lengthOf }))).toEqual([
      "Alpha", "Zed",
      "short.mp4", "also-mid.mkv", "mid.demorec", "long.mp4",
      "infinite.mp4", "nan.mp4", "negative.mp4", "notes.txt", "unreadable.avi",
    ]);
  });

  it("descending reverses the order within files and directories", () => {
    expect(names(sortEntries(entries, "length", false, { lengthOf }))).toEqual([
      "Zed", "Alpha",
      "unreadable.avi", "notes.txt", "negative.mp4", "nan.mp4", "infinite.mp4",
      "long.mp4", "mid.demorec", "also-mid.mkv", "short.mp4",
    ]);
  });

  it("ignores a length reported for a directory", () => {
    const withDirLength = (entry: FileEntry) => (entry.kind === "directory" ? 1 : lengthOf(entry));
    expect(names(sortEntries([dir("b"), dir("a")], "length", true, { lengthOf: withDirLength }))).toEqual(["a", "b"]);
  });

  it("without an accessor every file is unknown and sorts by name", () => {
    expect(names(sortEntries(entries, "length", true))).toEqual(names(sortEntries(entries, "name", true)));
  });

  it("re-sorts when a pending length arrives", () => {
    const known: Record<string, number> = { "b.mp4": 20 };
    const list = [file("a.mp4"), file("b.mp4"), file("c.mp4")];
    const of = (entry: FileEntry) => known[entry.name];
    expect(names(sortEntries(list, "length", true, { lengthOf: of }))).toEqual(["b.mp4", "a.mp4", "c.mp4"]);
    known["c.mp4"] = 10;
    expect(names(sortEntries(list, "length", true, { lengthOf: of }))).toEqual(["c.mp4", "b.mp4", "a.mp4"]);
  });
});

describe("persisted Length sort (#1531)", () => {
  beforeEach(() => localStorage.clear());

  it("accepts length as a sort field", () => {
    expect(isSortField("length")).toBe(true);
    expect(isSortField("duration")).toBe(false);
  });

  it("round-trips sortBy length through the per-folder preference", () => {
    saveSortPref("/videos", { sortBy: "length", sortAscending: false });
    expect(getSortPref("/videos")).toEqual({ sortBy: "length", sortAscending: false });
  });

  it("round-trips sortBy length through a window directory seed", () => {
    const seed = normalizeDirectorySeed({ currentPath: "/r", ts: 1000, entries: [], viewMode: "details", sortBy: "length", sortAscending: false }, "/r", 1000);
    expect(seed?.sortBy).toBe("length");
    expect(seed?.sortAscending).toBe(false);
    expect(normalizeDirectorySeed({ currentPath: "/r", ts: 1000, entries: [], viewMode: "details", sortBy: "duration", sortAscending: true }, "/r", 1000)).toBeNull();
  });
});
