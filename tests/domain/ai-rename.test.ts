/**
 * Domain logic for AI rename suggestions (src/lib/domain/ai-rename.ts):
 * content-hint gating and chosen-name sanitization, including malformed inputs.
 */

import { describe, it, expect } from "vitest";
import {
  buildContentHint,
  canSendContentHint,
  sanitizeChosenName,
  CONTENT_HINT_MAX_CHARS,
} from "$lib/domain/ai-rename";
import type { FileEntry } from "$lib/domain/file";

function file(name: string): FileEntry {
  return { name, path: `/home/user/${name}`, kind: "file", size: 1, modified: "2024-01-01T00:00:00.000Z" };
}
const dir: FileEntry = { name: "folder", path: "/home/user/folder", kind: "directory", size: 0, modified: "2024-01-01T00:00:00.000Z" };

describe("buildContentHint", () => {
  it("returns a trimmed head for a text file", () => {
    const hint = buildContentHint(file("notes.md"), "  # Title\nbody  ");
    expect(hint).toBe("# Title\nbody");
  });

  it("returns undefined for an image file even with text supplied", () => {
    expect(buildContentHint(file("photo.png"), "not really image bytes")).toBeUndefined();
  });

  it("returns undefined for a directory", () => {
    expect(buildContentHint(dir, "whatever")).toBeUndefined();
  });

  it("returns undefined for a text file when no head was read", () => {
    expect(buildContentHint(file("notes.txt"), undefined)).toBeUndefined();
    expect(buildContentHint(file("notes.txt"), "")).toBeUndefined();
    expect(buildContentHint(file("notes.txt"), "   ")).toBeUndefined();
  });

  it("truncates an oversized head to the cap", () => {
    const big = "a".repeat(CONTENT_HINT_MAX_CHARS * 2);
    const hint = buildContentHint(file("notes.txt"), big);
    expect(hint).toHaveLength(CONTENT_HINT_MAX_CHARS);
  });

  it("returns undefined for a non-text binary-ish extension", () => {
    expect(buildContentHint(file("archive.zip"), "PK...")).toBeUndefined();
  });
});

describe("canSendContentHint", () => {
  it("true for text, false for image/dir", () => {
    expect(canSendContentHint(file("readme.txt"))).toBe(true);
    expect(canSendContentHint(file("a.ts"))).toBe(true);
    expect(canSendContentHint(file("photo.png"))).toBe(false);
    expect(canSendContentHint(dir)).toBe(false);
  });
});

describe("sanitizeChosenName", () => {
  it("keeps a clean valid name", () => {
    expect(sanitizeChosenName("meeting-notes.md", "notes.md")).toBe("meeting-notes.md");
  });

  it("strips path traversal to the basename", () => {
    expect(sanitizeChosenName("../../etc/passwd.md", "notes.md")).toBe("passwd.md");
    expect(sanitizeChosenName("sub/dir/name.md", "notes.md")).toBe("name.md");
    expect(sanitizeChosenName("C:\\Windows\\evil.md", "notes.md")).toBe("evil.md");
  });

  it("falls back to the original on empty / dot-only names", () => {
    expect(sanitizeChosenName("", "notes.md")).toBe("notes.md");
    expect(sanitizeChosenName("   ", "notes.md")).toBe("notes.md");
    expect(sanitizeChosenName("..", "notes.md")).toBe("notes.md");
    expect(sanitizeChosenName(".", "notes.md")).toBe("notes.md");
  });

  it("re-appends the original extension when missing", () => {
    expect(sanitizeChosenName("renamed", "photo.png")).toBe("renamed.png");
  });

  it("replaces a divergent extension with the original", () => {
    expect(sanitizeChosenName("renamed.txt", "photo.png")).toBe("renamed.png");
  });

  it("leaves names untouched when the original has no extension", () => {
    expect(sanitizeChosenName("build-rules", "Makefile")).toBe("build-rules");
  });

  it("handles a huge input without throwing", () => {
    const huge = "x".repeat(100_000) + ".md";
    expect(sanitizeChosenName(huge, "notes.md")).toBe(huge);
  });
});
