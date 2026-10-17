import { expect, it } from "vitest";
import { buildPeekRows, flattenPeekEntries, entryIndicesForRows, peekTreePositionLookup, peekTreePositions } from "$lib/domain/folder-peek";
import { flatPeekEntries, flatPeekRows } from "$lib/domain/folder-peek-flat";
import type { FileEntry } from "$lib/domain/file";
const dir = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory", size: 0, modified: "2026-01-01T00:00:00Z" });
it("maps entry indices past editor and status rows, including marquee ranges", () => {
  const entries = [dir("/r/a"), dir("/r/b")];
  const expanded = new Map(entries.map((e, i) => [e.path, i]));
  const tree = flattenPeekEntries({ root: "/r", entries, expanded, listing: () => [], project: e => [...e], capability: "tree", windows: false });
  const layout = buildPeekRows(tree, () => ({ status: "loaded", entries: [] }), true);
  expect(layout.rows.map(r => r.kind)).toEqual(["create", "entry", "peek-state", "entry", "peek-state"]);
  expect(layout.entryToRow).toEqual([1, 3]);
  expect(entryIndicesForRows(layout, [0, 1, 2, 3, 4])).toEqual([0, 1]);
  expect(layout.groups.map(g => [g.startRow, g.endRow])).toEqual([[2, 3], [4, 5]]);
});

const file = (path: string): FileEntry => ({ ...dir(path), kind: "file" });
const treeOf = (entries: FileEntry[], listings: Record<string, FileEntry[]>, creating = false) => {
  const expanded = new Map(Object.keys(listings).map((path, i) => [path, i]));
  const tree = flattenPeekEntries({ root: "/r", entries, expanded, listing: path => listings[path], project: e => [...e], capability: "tree", windows: false });
  return buildPeekRows(tree, path => ({ status: "loaded", entries: listings[path] ?? [] }), creating);
};

it("states each entry's position among its own siblings, past nested levels and non-entry rows", () => {
  // /r: a (open: x, b (open: y)), c, d (open, empty)
  const layout = treeOf([dir("/r/a"), file("/r/c"), dir("/r/d")], {
    "/r/a": [file("/r/a/x"), dir("/r/a/b")],
    "/r/a/b": [file("/r/a/b/y")],
    "/r/d": [],
  }, true);
  const names = layout.rows.flatMap(row => row.kind === "entry" ? [row.entry.path] : []);
  expect(names).toEqual(["/r/a", "/r/a/x", "/r/a/b", "/r/a/b/y", "/r/c", "/r/d"]);
  const { posinset, setsize } = peekTreePositions(layout.rows);
  // Top level counts 3 (a, c, d) although nested rows sit between them.
  expect(posinset).toEqual([1, 1, 2, 1, 2, 3]);
  expect(setsize).toEqual([3, 2, 2, 1, 3, 3]);
});

it("treats a flat folder as one level and same-named folders under different parents as separate sets", () => {
  const flat = treeOf([file("/r/1"), file("/r/2"), file("/r/3")], {});
  expect(peekTreePositions(flat.rows)).toEqual({ posinset: [1, 2, 3], setsize: [3, 3, 3] });
  const twins = treeOf([dir("/r/a"), dir("/r/b")], { "/r/a": [file("/r/a/same")], "/r/b": [file("/r/b/same"), file("/r/b/other")] });
  expect(peekTreePositions(twins.rows)).toEqual({ posinset: [1, 1, 2, 1, 2], setsize: [2, 1, 2, 2, 2] });
  expect(peekTreePositions([])).toEqual({ posinset: [], setsize: [] });
});

it("looks positions up arithmetically while nothing is expanded, and from the tree otherwise", () => {
  const read = (lookup: ReturnType<typeof peekTreePositionLookup>, count: number) =>
    Array.from({ length: count }, (_, i) => [lookup.posinset(i), lookup.setsize(i)]);
  // Flat, with and without the creation row (entry indices skip it).
  for (const creating of [false, true]) {
    const flat = treeOf([dir("/r/a"), file("/r/b"), file("/r/c")], {}, creating);
    expect(flat.groups).toEqual([]);
    expect(read(peekTreePositionLookup(flat), 3)).toEqual([[1, 3], [2, 3], [3, 3]]);
    const { posinset, setsize } = peekTreePositions(flat.rows);
    expect(read(peekTreePositionLookup(flat), 3)).toEqual(posinset.map((p, i) => [p, setsize[i]]));
  }
  const many = flatPeekRows(flatPeekEntries("/r", Array.from({ length: 10_000 }, (_, i) => file(`/r/f${i}`))), false);
  expect([peekTreePositionLookup(many).posinset(9_999), peekTreePositionLookup(many).setsize(0)]).toEqual([10_000, 10_000]);
  // An expanded (even empty) folder makes it a tree.
  const nested = treeOf([dir("/r/a"), file("/r/c"), dir("/r/d")], { "/r/a": [file("/r/a/x")], "/r/d": [] });
  expect(read(peekTreePositionLookup(nested), 4)).toEqual([[1, 3], [1, 1], [2, 3], [3, 3]]);
  expect(read(peekTreePositionLookup(treeOf([], {})), 0)).toEqual([]);
});
