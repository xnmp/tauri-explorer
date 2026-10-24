import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { PeekMeta } from "$lib/domain/folder-peek";
import { prunePeekSelection, springPeekDropFolder } from "$lib/domain/folder-peek-pane";

const entry = (path: string, kind: FileEntry["kind"] = "file"): FileEntry =>
  ({ name: path.split("/").pop()!, path, kind, size: 0, modified: "2026-01-01T00:00:00Z" });

// /r is the pane root; /r/a is open with /r/a/b (open) holding /r/a/b/f.
const meta = new Map<string, PeekMeta>([
  ["/r/a", { depth: 0, parentPath: "/r" }],
  ["/r/x", { depth: 0, parentPath: "/r" }],
  ["/r/a/b", { depth: 1, parentPath: "/r/a" }],
  ["/r/a/g", { depth: 1, parentPath: "/r/a" }],
  ["/r/a/b/f", { depth: 2, parentPath: "/r/a/b" }],
]);
const tree = { entries: [...meta.keys()].map(path => entry(path, path.endsWith("f") || path.endsWith("g") ? "file" : "directory")), meta };
const without = (...paths: string[]) => tree.entries.filter(e => !paths.includes(e.path));

describe("prunePeekSelection", () => {
  it("is null when the projection hid nothing", () => {
    expect(prunePeekSelection(tree, tree.entries, ["/r/a/b/f"], "/r/a/b/f", null)).toBeNull();
  });
  it("is null when only top-level entries disappeared (a listing change, not a collapse)", () => {
    expect(prunePeekSelection(tree, without("/r/x"), ["/r/x"], "/r/x", "/r/x")).toBeNull();
  });
  it("drops hidden children from the selection and leaves an unaffected cursor alone", () => {
    const result = prunePeekSelection(tree, without("/r/a/b/f"), ["/r/a/b/f", "/r/x"], "/r/x", "/r/x");
    expect(result).toEqual({ selected: ["/r/x"] });
  });
  it("moves a hidden cursor to its nearest shown ancestor", () => {
    const result = prunePeekSelection(tree, without("/r/a/b", "/r/a/b/f", "/r/a/g"), ["/r/a/b/f"], "/r/a/b/f", null);
    expect(result).toEqual({ selected: [], refocus: "/r/a" });
  });
  it("uses the anchor when only the anchor hid", () => {
    const result = prunePeekSelection(tree, without("/r/a/b/f"), [], "/r/x", "/r/a/b/f");
    expect(result).toEqual({ selected: [], refocus: "/r/a/b" });
  });
  it("refocuses to null when no ancestor is shown", () => {
    const result = prunePeekSelection(tree, [], [], "/r/a/b/f", null);
    expect(result).toEqual({ selected: [], refocus: null });
  });
});

describe("springPeekDropFolder", () => {
  it("is null without temporary peeks", () => {
    expect(springPeekDropFolder("/r/a/b/f", "file", meta, [], "/r")).toBeNull();
  });
  it("targets a file row's folder inside a temporary peek", () => {
    expect(springPeekDropFolder("/r/a/b/f", "file", meta, ["/r/a"], "/r")).toBe("/r/a/b");
  });
  it("targets a directory or state row itself inside a temporary peek", () => {
    expect(springPeekDropFolder("/r/a/b", "directory", meta, ["/r/a"], "/r")).toBe("/r/a/b");
    expect(springPeekDropFolder("/r/a", "state", meta, ["/r/a"], "/r")).toBe("/r/a");
  });
  it("is null for rows outside every temporary peek, including root files", () => {
    expect(springPeekDropFolder("/r/x", "directory", meta, ["/r/a"], "/r")).toBeNull();
    expect(springPeekDropFolder("/r/a", "file", meta, ["/r/a"], "/r")).toBeNull();
  });
  it("is null for an unknown file row", () => {
    expect(springPeekDropFolder("/elsewhere/f", "file", meta, ["/r/a"], "/r")).toBeNull();
  });
});
