/**
 * Unit tests for the unified-diff parser (#55).
 * Asserts line-kind classification, line-number tracking, add/delete/rename
 * detection, and binary-file handling.
 */
import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "$lib/domain/diff";

describe("parseUnifiedDiff", () => {
  it("classifies add, remove, and context lines with line numbers", () => {
    const patch = [
      "diff --git a/foo.txt b/foo.txt",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    expect(diff.binary).toBe(false);
    expect(diff.added).toBe(false);
    expect(diff.deleted).toBe(false);
    expect(diff.oldPath).toBe("foo.txt");
    expect(diff.newPath).toBe("foo.txt");

    const kinds = diff.lines.map((l) => l.kind);
    expect(kinds).toEqual(["header", "meta", "meta", "hunk", "context", "remove", "add", "context"]);

    const context1 = diff.lines[4];
    expect(context1.text).toBe("alpha");
    expect(context1.oldLine).toBe(1);
    expect(context1.newLine).toBe(1);

    const removed = diff.lines[5];
    expect(removed.text).toBe("beta");
    expect(removed.oldLine).toBe(2);
    expect(removed.newLine).toBeNull();

    const added = diff.lines[6];
    expect(added.text).toBe("BETA");
    expect(added.oldLine).toBeNull();
    expect(added.newLine).toBe(2);
  });

  it("detects added files (old side /dev/null)", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    expect(diff.added).toBe(true);
    expect(diff.deleted).toBe(false);
    expect(diff.newPath).toBe("new.txt");
    expect(diff.oldPath).toBeNull();

    const addLines = diff.lines.filter((l) => l.kind === "add");
    expect(addLines.map((l) => l.newLine)).toEqual([1, 2]);
  });

  it("detects deleted files (new side /dev/null)", () => {
    const patch = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-byebye",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    expect(diff.added).toBe(false);
    expect(diff.deleted).toBe(true);
    expect(diff.oldPath).toBe("gone.txt");
    expect(diff.newPath).toBeNull();
  });

  it("detects renames in the header meta lines", () => {
    const patch = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    expect(diff.oldPath).toBe("old.txt");
    expect(diff.newPath).toBe("new.txt");
  });

  it("flags binary diffs and does not attempt to parse line content", () => {
    const patch = [
      "diff --git a/image.png b/image.png",
      "index 0000000..1111111",
      "Binary files a/image.png and b/image.png differ",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    expect(diff.binary).toBe(true);
    expect(diff.lines.some((l) => l.kind === "binary")).toBe(true);
  });

  it("handles empty input", () => {
    expect(parseUnifiedDiff("")).toEqual({
      binary: false,
      added: false,
      deleted: false,
      oldPath: null,
      newPath: null,
      lines: [],
      hunks: [],
    });
  });

  it("tracks line numbers correctly across multiple hunks", () => {
    const patch = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,3 @@",
      " j",
      "+K",
      " k",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    const firstAdd = diff.lines.find((l) => l.kind === "add" && l.text === "B");
    expect(firstAdd?.newLine).toBe(2);

    const secondAdd = diff.lines.find((l) => l.kind === "add" && l.text === "K");
    expect(secondAdd?.newLine).toBe(11);

    const contextK = diff.lines.find((l) => l.kind === "context" && l.text === "k");
    expect(contextK?.oldLine).toBe(11);
    expect(contextK?.newLine).toBe(12);
  });

  it("preserves a 'No newline at end of file' marker as meta", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    expect(diff.lines.some((l) => l.kind === "meta" && l.text.startsWith("\\ No newline"))).toBe(true);
    // Line numbers shouldn't advance for the \ marker.
    const newAdd = diff.lines.find((l) => l.kind === "add" && l.text === "new");
    expect(newAdd?.newLine).toBe(1);
  });
});

describe("parseUnifiedDiff header parsing inside hunks", () => {
  it("treats '--- '/'+++ ' content lines inside a hunk as remove/add, not file headers", () => {
    // A removed line whose content starts with "-- " serializes as "--- …".
    // Treating it as a file header would corrupt oldPath and desync cursors.
    const patch = [
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,3 +1,3 @@",
      " intro",
      "--- old divider",
      "+++ new divider",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    expect(diff.oldPath).toBe("notes.txt");
    expect(diff.newPath).toBe("notes.txt");
    expect(diff.added).toBe(false);
    expect(diff.deleted).toBe(false);

    const kinds = diff.lines.map((l) => l.kind);
    expect(kinds).toEqual(["header", "meta", "meta", "hunk", "context", "remove", "add"]);

    const removed = diff.lines[5];
    expect(removed.text).toBe("-- old divider");
    expect(removed.oldLine).toBe(2);
    expect(removed.newLine).toBeNull();

    const added = diff.lines[6];
    expect(added.text).toBe("++ new divider");
    expect(added.oldLine).toBeNull();
    expect(added.newLine).toBe(2);
  });

  it("does not treat 'rename from/to' content lines inside a hunk as rename meta", () => {
    const patch = [
      "diff --git a/doc.txt b/doc.txt",
      "--- a/doc.txt",
      "+++ b/doc.txt",
      "@@ -1,2 +1,2 @@",
      "-rename from old.txt",
      "+rename to new.txt",
      "",
    ].join("\n");

    const diff = parseUnifiedDiff(patch);
    // Paths must come from the real headers, not the hunk content.
    expect(diff.oldPath).toBe("doc.txt");
    expect(diff.newPath).toBe("doc.txt");
    const kinds = diff.lines.map((l) => l.kind);
    expect(kinds).toEqual(["header", "meta", "meta", "hunk", "remove", "add"]);
  });
});
