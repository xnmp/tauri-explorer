/**
 * Tests for domain layer - file entry operations.
 * Issue: tauri-explorer-1yj
 */

import { describe, it, expect } from "vitest";
import {
  sortEntries,
  filterHidden,
  formatSize,
  type FileEntry,
} from "$lib/domain/file";

const mockEntries: FileEntry[] = [
  {
    name: "zebra.txt",
    path: "/zebra.txt",
    kind: "file",
    size: 100,
    modified: "2025-01-01T00:00:00",
  },
  {
    name: "alpha",
    path: "/alpha",
    kind: "directory",
    size: 0,
    modified: "2025-01-02T00:00:00",
  },
  {
    name: ".hidden",
    path: "/.hidden",
    kind: "file",
    size: 50,
    modified: "2025-01-03T00:00:00",
  },
  {
    name: "beta.txt",
    path: "/beta.txt",
    kind: "file",
    size: 200,
    modified: "2025-01-04T00:00:00",
  },
];

describe("sortEntries", () => {
  it("places directories before files", () => {
    const sorted = sortEntries(mockEntries);
    expect(sorted[0].kind).toBe("directory");
  });

  it("sorts files alphabetically by name (case-insensitive)", () => {
    const sorted = sortEntries(mockEntries);
    const fileNames = sorted.filter((e) => e.kind === "file").map((e) => e.name);
    expect(fileNames).toEqual([".hidden", "beta.txt", "zebra.txt"]);
  });

  it("sorts by size when specified", () => {
    const sorted = sortEntries(mockEntries, "size");
    const files = sorted.filter((e) => e.kind === "file");
    expect(files[0].size).toBeLessThanOrEqual(files[1].size);
  });

  it("sorts by modified date when specified", () => {
    const sorted = sortEntries(mockEntries, "modified");
    const files = sorted.filter((e) => e.kind === "file");
    expect(files[0].modified).toBe("2025-01-01T00:00:00");
  });

  it("respects descending order", () => {
    const sorted = sortEntries(mockEntries, "name", false);
    const fileNames = sorted.filter((e) => e.kind === "file").map((e) => e.name);
    expect(fileNames).toEqual(["zebra.txt", "beta.txt", ".hidden"]);
  });

  it("does not mutate the original array", () => {
    const original = [...mockEntries];
    sortEntries(mockEntries);
    expect(mockEntries).toEqual(original);
  });
});

describe("filterHidden", () => {
  it("hides dotfiles when showHidden is false", () => {
    const filtered = filterHidden(mockEntries, false);
    expect(filtered.find((e) => e.name === ".hidden")).toBeUndefined();
  });

  it("shows dotfiles when showHidden is true", () => {
    const filtered = filterHidden(mockEntries, true);
    expect(filtered.find((e) => e.name === ".hidden")).toBeDefined();
  });

  it("does not mutate the original array", () => {
    const original = [...mockEntries];
    filterHidden(mockEntries, false);
    expect(mockEntries).toEqual(original);
  });
});

describe("formatSize", () => {
  it("returns empty string for 0 (directories)", () => {
    expect(formatSize(0)).toBe("");
  });

  it("formats bytes correctly", () => {
    expect(formatSize(500)).toBe("500.0 B");
  });

  it("formats kilobytes correctly", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes correctly", () => {
    expect(formatSize(1048576)).toBe("1.0 MB");
  });

  it("formats gigabytes correctly", () => {
    expect(formatSize(1073741824)).toBe("1.0 GB");
  });
});
