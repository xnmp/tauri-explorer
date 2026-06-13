/**
 * Tests for file-types domain helpers: formatDate guards and
 * getExtension semantics (shared with nerd-icons).
 */
import { describe, it, expect } from "vitest";
import { formatDate, getExtension } from "$lib/domain/file-types";

describe("formatDate", () => {
  it("formats a valid ISO timestamp", () => {
    const out = formatDate("2024-03-15T14:30:00Z");
    expect(out).not.toBe("");
    expect(out).not.toContain("Invalid");
    expect(out).toContain("2024");
  });

  it("returns empty string for malformed input instead of 'Invalid Date'", () => {
    expect(formatDate("not-a-date")).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("2024-99-99T99:99:99Z")).toBe("");
  });

  it("handles extreme but valid timestamps", () => {
    expect(formatDate("1970-01-01T00:00:00Z")).not.toContain("Invalid");
    // Mid-year noon UTC stays in 2999 in every timezone.
    expect(formatDate("2999-06-15T12:00:00Z")).toContain("2999");
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
