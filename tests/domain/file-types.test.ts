/**
 * Tests for file-types domain helpers: formatDate guards and
 * getExtension semantics (shared with nerd-icons).
 */
import { describe, it, expect } from "vitest";
import {
  formatDate,
  getExtension,
  isZipFile,
  getFileType,
  getFileIconColor,
  getFileIconCategory,
  isTextFile,
  isGitRepoFolder,
} from "$lib/domain/file-types";
import type { FileEntry } from "$lib/domain/file";

const entry = (
  name: string,
  kind: "file" | "directory" = "file",
  extra: Partial<FileEntry> = {}
): FileEntry => ({
  name,
  path: `/x/${name}`,
  kind,
  size: 0,
  modified: "",
  ...extra,
});

describe("formatDate", () => {
  it("renders elapsed days, weeks, and months with compact relative labels", () => {
    const now = new Date("2024-06-15T12:00:00Z");

    expect(formatDate("2024-06-10T12:00:00Z", now)).toBe("5d");
    expect(formatDate("2024-05-11T12:00:00Z", now)).toBe("5w");
    expect(formatDate("2024-01-15T12:00:00Z", now)).toBe("5mo");
  });

  it("keeps compact units consistent at day, week, month, and year boundaries", () => {
    const nowMs = Date.parse("2025-01-01T12:00:00Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const atAge = (days: number) =>
      formatDate(new Date(nowMs - days * dayMs).toISOString(), new Date(nowMs));

    expect(atAge(6)).toBe("6d");
    expect(atAge(7)).toBe("1w");
    expect(atAge(59)).toBe("1mo");
    expect(atAge(60)).toBe("2mo");
    expect(atAge(359)).toBe("11mo");
    expect(atAge(360)).toBe("12mo");
    expect(atAge(365)).toBe("1y");
  });

  it("formats a valid ISO timestamp as a compact elapsed interval", () => {
    expect(formatDate("2024-03-15T14:30:00Z", new Date("2024-03-15T15:30:00Z"))).toBe("1h");
  });

  it("returns empty string for malformed input instead of 'Invalid Date'", () => {
    expect(formatDate("not-a-date")).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("2024-99-99T99:99:99Z")).toBe("");
  });

  it("handles extreme but valid timestamps", () => {
    expect(formatDate("1970-01-01T00:00:00Z")).not.toContain("Invalid");
    expect(formatDate("2999-06-15T12:00:00Z")).toBe("now");
  });
});

describe("getExtension", () => {
  it("extracts lowercase extension", () => {
    expect(getExtension("Photo.JPG")).toBe("jpg");
    expect(getExtension("archive.tar.gz")).toBe("gz");
  });

  it("treats dotfiles as having no extension", () => {
    expect(getExtension(".bashrc")).toBe("");
    expect(getExtension(".gitignore")).toBe("");
  });

  it("returns empty string for extensionless names", () => {
    expect(getExtension("Makefile")).toBe("");
    expect(getExtension("")).toBe("");
  });
});

describe("isZipFile", () => {
  it("matches .zip files case-insensitively", () => {
    expect(isZipFile(entry("archive.zip"))).toBe(true);
    expect(isZipFile(entry("Backup.ZIP"))).toBe(true);
  });

  it("rejects non-zip files and directories", () => {
    expect(isZipFile(entry("notes.txt"))).toBe(false);
    expect(isZipFile(entry("photo.zip.bak"))).toBe(false);
    expect(isZipFile(entry("archive.tar.gz"))).toBe(false);
    expect(isZipFile(entry("archive.zip", "directory"))).toBe(false);
  });
});

describe("isGitRepoFolder", () => {
  it("is true only for directories flagged is_git_repo by the backend", () => {
    expect(isGitRepoFolder(entry("repo", "directory", { is_git_repo: true }))).toBe(true);
  });

  it("is false for a plain directory (is_git_repo absent or false)", () => {
    expect(isGitRepoFolder(entry("plain", "directory"))).toBe(false);
    expect(isGitRepoFolder(entry("plain", "directory", { is_git_repo: false }))).toBe(false);
  });

  it("is false for a file even if is_git_repo were somehow set (defensive)", () => {
    expect(isGitRepoFolder(entry("weird.txt", "file", { is_git_repo: true }))).toBe(false);
  });
});

describe("AutoHotkey (.ahk) and shortcut (.lnk) file types", () => {
  it("names the file types", () => {
    expect(getFileType(entry("remap.ahk"))).toBe("AutoHotkey Script");
    expect(getFileType(entry("game.lnk"))).toBe("Shortcut");
  });

  it("gives them distinct colors (not the default gray)", () => {
    expect(getFileIconColor(entry("remap.ahk"))).toBe("#5f9e54");
    expect(getFileIconColor(entry("game.lnk"))).toBe("#4273ca");
  });

  it("treats .ahk as previewable code, but .lnk as opaque binary", () => {
    expect(getFileIconCategory(entry("remap.ahk"))).toBe("code");
    expect(isTextFile(entry("remap.ahk"))).toBe(true);
    expect(getFileIconCategory(entry("game.lnk"))).toBe("default");
    expect(isTextFile(entry("game.lnk"))).toBe(false);
  });
});
