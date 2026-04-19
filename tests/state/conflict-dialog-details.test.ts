/**
 * Regression test: conflict dialog must receive source metadata.
 * Issue: fix/conflict-dialog-display
 */
import { describe, it, expect } from "vitest";
import type { PasteSource } from "$lib/state/paste-operations";

describe("Conflict dialog metadata", () => {
  it("PasteSource includes size and modified when created from FileEntry", () => {
    const entry = { path: "/a/file.txt", name: "file.txt", kind: "file" as const, size: 1024, modified: "2026-03-21T04:47:09" };
    const source: PasteSource = {
      path: entry.path,
      name: entry.name,
      size: entry.size,
      modified: entry.modified,
    };
    expect(source.size).toBe(1024);
    expect(source.modified).toBe("2026-03-21T04:47:09");
  });

  it("PasteSource size/modified are optional for OS clipboard entries", () => {
    const source: PasteSource = { path: "/a/file.txt", name: "file.txt" };
    expect(source.size).toBeUndefined();
    expect(source.modified).toBeUndefined();
  });
});
