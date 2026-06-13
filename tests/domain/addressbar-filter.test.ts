/**
 * Address bar autocomplete: suggestion filtering and path-input parsing.
 * Tests the real functions behind BreadcrumbAutocomplete.svelte.
 * Issue: fix/addressbar-folder-only
 */
import { describe, it, expect } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import {
  filterDirectorySuggestions,
  parsePathInput,
  MAX_SUGGESTIONS,
} from "$lib/domain/autocomplete";

const entry = (name: string, kind: "file" | "directory"): FileEntry => ({
  name,
  path: `/home/user/${name}`,
  kind,
  size: 0,
  modified: "",
});

const mockEntries: FileEntry[] = [
  entry("Documents", "directory"),
  entry("Downloads", "directory"),
  entry("notes.md", "file"),
  entry("readme.txt", "file"),
];

describe("filterDirectorySuggestions", () => {
  it("filters to directories only", () => {
    const filtered = filterDirectorySuggestions(mockEntries, "");
    expect(filtered.map((e) => e.name)).toEqual(["Documents", "Downloads"]);
  });

  it("filters by prefix case-insensitively", () => {
    expect(filterDirectorySuggestions(mockEntries, "do").map((e) => e.name)).toEqual([
      "Documents",
      "Downloads",
    ]);
    expect(filterDirectorySuggestions(mockEntries, "doc").map((e) => e.name)).toEqual([
      "Documents",
    ]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterDirectorySuggestions(mockEntries, "zzz")).toEqual([]);
  });

  it("caps results at the suggestion limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry(`dir-${String(i).padStart(2, "0")}`, "directory"),
    );
    expect(filterDirectorySuggestions(many, "dir")).toHaveLength(MAX_SUGGESTIONS);
  });

  it("sorts suggestions by name", () => {
    const unsorted = [entry("zeta", "directory"), entry("alpha", "directory")];
    expect(filterDirectorySuggestions(unsorted, "").map((e) => e.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("handles empty input", () => {
    expect(filterDirectorySuggestions([], "any")).toEqual([]);
  });
});

describe("parsePathInput", () => {
  const HOME = "/home/user";

  it("splits a partial path into parent dir and prefix", () => {
    expect(parsePathInput("/home/us", null)).toEqual({ parentDir: "/home/", prefix: "us" });
  });

  it("trailing slash lists that directory with empty prefix", () => {
    expect(parsePathInput("/home/", null)).toEqual({ parentDir: "/home/", prefix: "" });
  });

  it("expands tilde against the home directory", () => {
    expect(parsePathInput("~/Doc", HOME)).toEqual({
      parentDir: "/home/user/",
      prefix: "Doc",
    });
  });

  it("bare name falls back to root", () => {
    expect(parsePathInput("name", null)).toEqual({ parentDir: "/", prefix: "name" });
  });

  it("empty and root inputs list root", () => {
    expect(parsePathInput("", null)).toEqual({ parentDir: "/", prefix: "" });
    expect(parsePathInput("/", null)).toEqual({ parentDir: "/", prefix: "" });
  });
});
