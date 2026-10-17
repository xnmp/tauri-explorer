import { describe, expect, it } from "vitest";
import { archiveRoots, operationRoots, operationDrag } from "$lib/domain/file-operation-selection";
import type { FileEntry } from "$lib/domain/file";
const dir = (path: string, symlink = false): FileEntry => ({ path, name: path, kind: "directory", size: 0, modified: "", is_symlink: symlink });
it("reduces covered descendants in stable order without changing UI selection", () => {
  const parent = dir("/r/a"), child = dir("/r/a/b"), other = dir("/r/ab");
  const selection = [child, other, parent];
  expect(operationRoots(selection, false)).toEqual({ ok: true, entries: [other, parent] });
  expect(operationDrag(selection, child, false)).toEqual({ ok: true, entries: [other, parent], primary: parent });
  expect(selection).toEqual([child, other, parent]);
});
it("rejects overlapping symlink ancestors but accepts independent symlinks", () => {
  expect(operationRoots([dir("/r/a", true), dir("/r/a/b")], false).ok).toBe(false);
  expect(operationRoots([dir("/r/a", true), dir("/r/b")], false).ok).toBe(true);
});
it("uses native platform boundaries", () => {
  const selection = [dir("C:\\r\\a"), dir("c:/r/a/b"), dir("C:\\r\\ab")];
  expect(operationRoots(selection, true)).toEqual({ ok: true, entries: [selection[0], selection[2]] });
  expect(operationRoots([dir("/r/a"), dir("/r/a\\b")], false).ok).toBe(true);
});

it("rejects a selected ancestor covering an unselected symlink boundary", () => {
  const parent = dir("/r/a"), link = dir("/r/a/link", true), child = dir("/r/a/link/child");
  expect(operationRoots([parent, child], false, [parent, link, child]).ok).toBe(false);
  expect(operationRoots([child], false, [parent, link, child])).toEqual({ ok: true, entries: [child] });
});

it("treats filesystem roots as covering every descendant", () => {
  const root = dir("/"), child = dir("/r/a"), drive = dir("C:\\"), driveChild = dir("c:/x/y"), share = dir("\\\\host\\share"), shareChild = dir("//HOST/share/x");
  expect(operationRoots([child, root], false)).toEqual({ ok: true, entries: [root] });
  expect(operationRoots([driveChild, drive], true)).toEqual({ ok: true, entries: [drive] });
  expect(operationRoots([shareChild, share], true)).toEqual({ ok: true, entries: [share] });
});
it("keeps uncomparable paths and literal duplicates out of coverage", () => {
  const relative = dir("r/a/b"), parent = dir("r/a"), file = { ...dir("/r/a/f"), kind: "file" as const };
  expect(operationRoots([parent, relative, relative], false)).toEqual({ ok: true, entries: [parent, relative] });
  // A file is never a covering parent, and duplicates collapse by key.
  expect(operationRoots([file, dir("/r/a/f/x"), { ...file, path: "/r//a/f" }], false)).toEqual({ ok: true, entries: [file, dir("/r/a/f/x")] });
  expect(operationDrag([relative], relative, false)).toEqual({ ok: true, entries: [relative], primary: relative });
});
it("reduces ten thousand siblings and nested children in linear time", () => {
  const siblings = Array.from({ length: 10_000 }, (_, i) => dir(`/r/folder-${i}`));
  const children = siblings.slice(0, 1_000).flatMap(parent => [dir(`${parent.path}/x`), dir(`${parent.path}/x/y`)]);
  const links = siblings.slice(5_000, 5_010).map(entry => ({ ...entry, is_symlink: true }));
  const selection = [...children, ...siblings];
  const started = performance.now();
  const result = operationRoots(selection, false, [...selection, ...links]);
  const drag = operationDrag(selection, children[1], false);
  const elapsed = performance.now() - started;
  expect(result).toEqual({ ok: true, entries: siblings });
  expect(drag.ok && drag.primary).toBe(siblings[0]);
  // The quadratic reduction took ~1.4s for 1,000 siblings and ~23s for 4,000.
  expect(elapsed).toBeLessThan(1_500);
});

describe("archive roots", () => {
  const file = (path: string): FileEntry => ({ path, name: path.split(/[\\/]/).at(-1)!, kind: "file", size: 1, modified: "" });
  it("refuses reduced roots that share a basename, case-insensitively on Windows", () => {
    expect(archiveRoots([file("/r/a/same.txt"), file("/r/b/same.txt")], false)).toEqual({ ok: false, error: "Selected items have the same name" });
    expect(archiveRoots([file("/r/a/Same.txt"), file("/r/b/same.txt")], false).ok).toBe(true);
    expect(archiveRoots([file("C:\\r\\a\\Same.txt"), file("C:\\r\\b\\same.txt")], true)).toEqual({ ok: false, error: "Selected items have the same name" });
  });
  it("reduces before checking names, and keeps a repeated selection of one path", () => {
    const folder: FileEntry = { ...file("/r/a"), kind: "directory" };
    expect(archiveRoots([folder, file("/r/a/same.txt"), file("/r/b/same.txt")], false)).toEqual({ ok: true, entries: [folder, file("/r/b/same.txt")] });
    expect(archiveRoots([file("/r/a/x"), file("/r/a/x")], false)).toEqual({ ok: true, entries: [file("/r/a/x")] });
  });
});
