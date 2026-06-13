/**
 * Tests for nerd-icons icon resolution, in particular that its extension
 * handling matches file-types getExtension (dotfiles have no extension).
 */
import { describe, it, expect } from "vitest";
import { getNerdIcon, DEFAULT_FILE_ICON, FOLDER_ICON } from "$lib/domain/nerd-icons";

describe("getNerdIcon", () => {
  it("returns the folder icon for directories regardless of name", () => {
    expect(getNerdIcon("src", "directory")).toBe(FOLDER_ICON);
    expect(getNerdIcon("photo.jpg", "directory")).toBe(FOLDER_ICON);
  });

  it("resolves well-known filenames before extensions", () => {
    expect(getNerdIcon(".gitignore", "file")).not.toBe(DEFAULT_FILE_ICON);
  });

  it("resolves by extension, case-insensitively", () => {
    const lower = getNerdIcon("main.ts", "file");
    const upper = getNerdIcon("MAIN.TS", "file");
    expect(lower).not.toBe(DEFAULT_FILE_ICON);
    expect(upper).toBe(lower);
  });

  it("does not treat a dotfile's name as its extension", () => {
    // ".md" must NOT resolve to the markdown icon: per getExtension
    // semantics, dotfiles have no extension.
    expect(getNerdIcon(".md", "file")).toBe(DEFAULT_FILE_ICON);
    expect(getNerdIcon(".ts", "file")).toBe(DEFAULT_FILE_ICON);
  });

  it("falls back to the default icon for unknown names", () => {
    expect(getNerdIcon("mystery.zzz9", "file")).toBe(DEFAULT_FILE_ICON);
    expect(getNerdIcon("", "file")).toBe(DEFAULT_FILE_ICON);
  });
});
