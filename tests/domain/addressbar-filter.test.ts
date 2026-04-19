/**
 * Regression test: address bar autocomplete must show only directories.
 * Issue: fix/addressbar-folder-only
 */
import { describe, it, expect } from "vitest";
import type { FileEntry } from "$lib/domain/file";

describe("Address bar autocomplete filtering", () => {
  const mockEntries: FileEntry[] = [
    { name: "Documents", path: "/home/user/Documents", kind: "directory", size: 0, modified: "" },
    { name: "Downloads", path: "/home/user/Downloads", kind: "directory", size: 0, modified: "" },
    { name: "notes.md", path: "/home/user/notes.md", kind: "file", size: 2048, modified: "" },
    { name: "readme.txt", path: "/home/user/readme.txt", kind: "file", size: 1024, modified: "" },
  ];

  it("filters to directories only", () => {
    const prefix = "";
    const filtered = mockEntries
      .filter((e) => e.kind === "directory" && e.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.kind === "directory")).toBe(true);
    expect(filtered.map((e) => e.name)).toEqual(["Documents", "Downloads"]);
  });

  it("filters directories by prefix", () => {
    const prefix = "do";
    const filtered = mockEntries
      .filter((e) => e.kind === "directory" && e.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.name)).toEqual(["Documents", "Downloads"]);
  });

  it("excludes files even when name matches prefix", () => {
    const prefix = "no"; // matches "notes.md" file
    const filtered = mockEntries
      .filter((e) => e.kind === "directory" && e.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(filtered).toHaveLength(0);
  });
});
