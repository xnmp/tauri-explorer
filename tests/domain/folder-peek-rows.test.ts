import { describe, expect, it } from "vitest";
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

describe("flat projection (#1416)", () => {
  const listing = [dir("/r/a"), file("/r/b"), file("/r/c")];
  const plainRow = (entry: FileEntry, entryIndex: number) =>
    ({ kind: "entry", key: `entry:${entry.path}`, entry, entryIndex, depth: 0, parentPath: "/r", expanded: false });

  it("places every listed path at depth 0 under the root and nothing else", () => {
    const { meta } = flatPeekEntries("/r", listing);
    expect(meta.size).toBe(3);
    expect(meta.get("/r/b")).toEqual({ depth: 0, parentPath: "/r" });
    expect(meta.has("/r/c")).toBe(true);
    expect(meta.get("/r/missing")).toBeUndefined();
    expect(meta.has("/elsewhere/a")).toBe(false);
    expect([...meta.keys()]).toEqual(["/r/a", "/r/b", "/r/c"]);
    expect(new Map(meta)).toEqual(new Map(listing.map(entry => [entry.path, { depth: 0, parentPath: "/r" }])));
    expect(flatPeekEntries("/r", []).meta.size).toBe(0);
  });

  it("exposes the same row fields as tree rows, with and without the creation row", () => {
    const tree = flatPeekEntries("/r", listing);
    for (const creating of [false, true]) {
      const { rows, entryToRow, rowToEntry } = flatPeekRows(tree, creating);
      const entryRows = rows.slice(Number(creating)).map(row => row.kind === "entry"
        ? { kind: row.kind, key: row.key, entry: row.entry, entryIndex: row.entryIndex, depth: row.depth, parentPath: row.parentPath, expanded: row.expanded }
        : row);
      expect(entryRows).toEqual(listing.map(plainRow));
      expect(rows[0].key).toBe(creating ? "create" : "entry:/r/a");
      expect(entryToRow).toEqual([0, 1, 2].map(i => i + Number(creating)));
      expect(rowToEntry).toEqual([...(creating ? [null] : []), 0, 1, 2]);
    }
  });

  it("builds tree rows identical to flat rows while nothing in the listing is expanded", () => {
    const tree = flattenPeekEntries({ root: "/r", entries: listing, expanded: new Map([["/elsewhere", 1]]), listing: () => [], project: e => [...e], capability: "tree", windows: false });
    const tree_ = buildPeekRows(tree, () => undefined);
    const flat = flatPeekRows(flatPeekEntries("/r", listing), false);
    expect(tree_.rows.map(row => row.key)).toEqual(flat.rows.map(row => row.key));
    expect(tree_.rows.every((row, i) => row.kind === "entry" && row.entry === listing[i] && row.depth === 0 && row.parentPath === "/r" && !row.expanded)).toBe(true);
    expect([tree_.entryToRow, tree_.rowToEntry, tree_.groups]).toEqual([flat.entryToRow, flat.rowToEntry, flat.groups]);
  });

  it("projects a large listing without reading any entry's path until a row or placement asks", () => {
    let pathReads = 0;
    const counted = Array.from({ length: 50_000 }, (_, i) => {
      const entry = file(`/r/f${i}`);
      return Object.defineProperty({ ...entry }, "path", { get: () => { pathReads++; return entry.path; }, enumerable: true });
    });
    const tree = flatPeekEntries("/r", counted);
    const { rows } = flatPeekRows(tree, false);
    expect(pathReads).toBe(0);
    expect(rows[7].key).toBe("entry:/r/f7");
    expect(pathReads).toBe(1);
    expect(tree.meta.get("/r/f49999")?.depth).toBe(0);
  });
});
