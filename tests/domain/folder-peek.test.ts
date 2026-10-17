import { describe, expect, it } from "vitest";
import { flattenPeekEntries, toggleExpanded, collapseSubtree, pruneExpanded, choosePeekWatches, peekCapability, resolvePeekCommandTarget, resolvePeekEscape } from "$lib/domain/folder-peek";
import { pathComparison } from "$lib/domain/path";
import { sortEntries, filterHidden, type FileEntry } from "$lib/domain/file";

const entry = (path: string, kind: FileEntry["kind"] = "directory", size = 0): FileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind, size, modified: "2026-01-01T00:00:00Z" });
const a = entry("/r/a"), b = entry("/r/b"), nested = entry("/r/a/n"), file = entry("/r/a/n/f", "file");
const listings = new Map([[a.path, [nested]], [nested.path, [file]]]);
function flatten(expanded = new Map([[a.path, 1], [nested.path, 2]]), roots = [a, b]) {
  return flattenPeekEntries({ root: "/r", entries: roots, expanded, listing: path => listings.get(path), project: entries => [...entries], capability: "tree", windows: false });
}

describe("folder peek preorder and policies", () => {
  it("ports nested, collapse and remembers-nested mock contracts", () => {
    expect(flatten().entries).toEqual([a, nested, file, b]);
    expect([...flatten().meta.values()]).toEqual([{ depth: 0, parentPath: "/r" }, { depth: 1, parentPath: a.path }, { depth: 2, parentPath: nested.path }, { depth: 0, parentPath: "/r" }]);
    const closed = toggleExpanded(new Map([[a.path, 1], [nested.path, 2]]), a.path, 3);
    expect(flatten(closed).entries).toEqual([a, b]);
    expect(flatten(toggleExpanded(closed, a.path, 4)).entries).toEqual([a, nested, file, b]);
  });
  it("sorts and hides each level independently; a missing root hides descendants", () => {
    const roots = [b, a];
    const result = flattenPeekEntries({ root: "/r", entries: sortEntries(roots, "name", true), expanded: new Map([[a.path, 1]]), listing: () => [entry("/r/a/.hidden", "file"), entry("/r/a/z", "file", 2), entry("/r/a/c", "file", 3)], project: entries => sortEntries(filterHidden(entries, false), "size", false), capability: "tree", windows: false });
    expect(result.entries.map(e => e.name)).toEqual(["a", "c", "z", "b"]);
    expect(flatten(undefined, [b]).entries).toEqual([b]);
    expect(roots).toEqual([b, a]);
  });
  it("rejects duplicates, malformed and non-direct children", () => {
    const result = flattenPeekEntries({ root: "/r", entries: [a, a, entry("/r/../bad"), entry("relative"), entry("/r/a/deep")], expanded: new Map([[a.path, 1]]), listing: () => [a, entry("/r/a/x", "file"), entry("/r/ab/x", "file")], project: entries => [...entries], capability: "tree", windows: false });
    expect(result.entries.map(e => e.path)).toEqual([a.path, "/r/a/x"]);
  });
  it("loads all 10,000 children and handles deep nesting iteratively", () => {
    const children = Array.from({ length: 10_000 }, (_, i) => entry(`/r/a/${i}`, "file"));
    expect(flattenPeekEntries({ root: "/r", entries: [a], expanded: new Map([[a.path, 1]]), listing: () => children, project: e => [...e], capability: "tree", windows: false }).entries).toHaveLength(10_001);
    const paths = Array.from({ length: 800 }, (_, i) => "/r/" + Array(i + 1).fill("x").join("/"));
    const tree = new Map(paths.map((p, i) => [p, i + 1 < paths.length ? [entry(paths[i + 1])] : []]));
    const result = flattenPeekEntries({ root: "/r", entries: [entry(paths[0])], expanded: new Map(paths.map((p, i) => [p, i])), listing: p => tree.get(p), project: e => [...e], capability: "tree", windows: false });
    expect(result.meta.get(paths.at(-1)!)?.depth).toBe(799);
  });
  it("keeps native path boundaries on Windows, UNC and POSIX backslashes", () => {
    for (const [windows, root, child, outside] of [[false, "/r", "/r/a\\b", "/r2/a"], [true, "C:\\r", "c:\\r\\a", "C:\\r2\\a"], [true, "\\\\host\\share", "\\\\HOST\\SHARE\\a", "\\\\host\\share2\\a"]] as const) {
      const cmp = pathComparison(windows);
      expect(cmp.sameParent(child, root)).toBe(true);
      expect(cmp.contains(outside, root)).toBe(false);
      const expanded = new Map([[child, 1], [outside, 2]]);
      expect([...collapseSubtree(expanded, root, windows).keys()]).toEqual([outside]);
      expect([...pruneExpanded(expanded, root, [], windows).keys()]).toEqual([outside]);
    }
  });
  it("prunes deleted/replaced folders including dormant descendants", () => {
    const expanded = new Map([[nested.path, 1], [b.path, 2], ["/else/a", 3]]);
    expect([...pruneExpanded(expanded, "/r", [entry(a.path, "file"), b], false).keys()]).toEqual([b.path, "/else/a"]);
  });
  it("caps membership by explicit toggle order and chooses newest 16 watches", () => {
    let expanded = new Map<string, number>();
    for (let i = 0; i < 501; i++) expanded = toggleExpanded(expanded, `/r/${i}`, i);
    expect(expanded.size).toBe(500);
    expect(expanded.has("/r/0")).toBe(false);
    expect(choosePeekWatches([...expanded.keys()], expanded)).toEqual(Array.from({ length: 16 }, (_, i) => `/r/${500 - i}`));
  });
  it.each([["setting off", { enabled: false }], ["git graph", { fileListing: false }], ["plugin view", { builtinView: false }], ["virtual location", { plainLocation: false }]] as const)(
    "treats %s exactly like an unsupported view", (_label, change) => {
      expect(peekCapability({ enabled: true, fileListing: true, builtinView: true, plainLocation: true, mode: "details", ...change })).toBe("none");
    });
  it("disables resources for unsupported views and resolves commands and Escape", () => {
    const surface = { enabled: true, fileListing: true, builtinView: true, plainLocation: true, mode: "details" as const };
    expect(peekCapability(surface)).toBe("tree");
    expect(peekCapability({ ...surface, mode: "list" })).toBe("none");
    expect(peekCapability({ ...surface, mode: "tiles" })).toBe("none");
    const tree = flatten();
    expect(resolvePeekCommandTarget(file, tree.meta)).toBe(nested.path);
    expect(resolvePeekCommandTarget(entry("/r/f", "file"), tree.meta)).toBeNull();
    expect(resolvePeekEscape(file, tree.meta)).toBe(nested.path);
    expect(resolvePeekEscape(a, tree.meta)).toBeNull();
  });
});
