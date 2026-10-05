import { describe, expect, it } from "vitest";
import { matchesPickerExtensions } from "$lib/domain/file-picker";

describe("picker extension filter", () => {
  it("keeps folders navigable, admits package extensions case-insensitively, and rejects lookalikes", () => {
    const candidates = [
      { name: "Downloads", kind: "directory" },
      { name: "TraceExplorer.teplugin", kind: "file" },
      { name: "TraceExplorer.TEPLUGIN", kind: "file" },
      { name: "TraceExplorer.teplugin.zip", kind: "file" },
      { name: "teplugin", kind: "file" },
      { name: "notes.md", kind: "file" },
      { name: "", kind: "file" },
    ];
    expect(candidates.filter((entry) => matchesPickerExtensions(entry, ["teplugin"])))
      .toEqual(candidates.slice(0, 3));
  });

  it("preserves unfiltered pickers and accepts any listed extension", () => {
    expect(matchesPickerExtensions({ name: "notes.md", kind: "file" })).toBe(true);
    expect(matchesPickerExtensions({ name: "photo.PNG", kind: "file" }, ["jpg", "png"])).toBe(true);
  });
});
