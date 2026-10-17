import { expect, it } from "vitest";
import { operationRoots, operationDrag } from "$lib/domain/file-operation-selection";
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
