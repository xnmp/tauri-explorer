import { expect, it } from "vitest";
import { buildPeekRows, flattenPeekEntries, entryIndicesForRows } from "$lib/domain/folder-peek";
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
