import { describe, expect, it, vi } from "vitest";
import { createPeekLevelCache, flattenPeekEntries, toggleExpanded, collapseSubtree, pruneExpanded, choosePeekWatches, peekCapability, rememberWhileExpanded, withTemporaryPeeks, resolvePeekCommandTarget, resolvePeekEscape } from "$lib/domain/folder-peek";
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
  it("re-projects only levels whose listing snapshot or projection inputs changed", () => {
    const levels = createPeekLevelCache(false);
    const project = vi.fn((entries: readonly FileEntry[], _parent: string) => [...entries]);
    const tree = new Map([[a.path, [nested]], [nested.path, [file]], [b.path, [entry("/r/b/x", "file")]]]);
    const expanded = new Map([[a.path, 1], [nested.path, 2], [b.path, 3]]);
    const run = (roots = [a, b], inputs = "name") => flattenPeekEntries({ root: "/r", entries: roots, expanded, listing: path => tree.get(path), project, capability: "tree", windows: false, levels, projectionKey: () => inputs });
    expect(run().entries.map(e => e.path)).toEqual([a.path, nested.path, file.path, b.path, "/r/b/x"]);
    expect(project).toHaveBeenCalledTimes(3);
    // A root filter keystroke supplies a new root array; no child re-projects.
    project.mockClear();
    expect(run([a]).entries.map(e => e.path)).toEqual([a.path, nested.path, file.path]);
    expect(project).not.toHaveBeenCalled();
    // One level publishes a new snapshot; only that level re-projects.
    project.mockClear(); tree.set(nested.path, [file, entry("/r/a/n/g", "file")]);
    expect(run().entries.map(e => e.path)).toContain("/r/a/n/g");
    expect(project.mock.calls.map(([, parent]) => parent)).toEqual([nested.path]);
    // Sort or hidden-rule changes re-project every level.
    project.mockClear(); run(undefined, "size");
    expect(project.mock.calls.map(([, parent]) => parent).sort()).toEqual([a.path, nested.path, b.path].sort());
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
      expect([...collapseSubtree(expanded, [root], windows).keys()]).toEqual([outside]);
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
  it("temporary peeks join the projection below every user peek, without touching the stored set", () => {
    let expanded = new Map<string, number>();
    for (let i = 1; i <= 16; i++) expanded = toggleExpanded(expanded, `/r/${i}`, i);
    const stored = new Map(expanded);
    expect(withTemporaryPeeks(expanded, [])).toBe(expanded);
    const projected = withTemporaryPeeks(expanded, ["/r/spring", "/r/3"]);
    expect(projected.get("/r/spring")).toBe(0);
    // A temporary path that is already expanded keeps its user ordinal.
    expect(projected.get("/r/3")).toBe(3);
    expect(expanded).toEqual(stored);
    // At the watch cap, a temporary peek never evicts a user peek's watch.
    expect(choosePeekWatches([...projected.keys()], projected)).not.toContain("/r/spring");
    expect(choosePeekWatches(["/r/spring", "/r/1"], projected)).toEqual(["/r/1", "/r/spring"]);
  });
  it.each([["setting off", { enabled: false }], ["git graph", { fileListing: false }], ["plugin view", { builtinView: false }], ["virtual location", { plainLocation: false }]] as const)(
    "treats %s exactly like an unsupported view", (_label, change) => {
      expect(peekCapability({ enabled: true, fileListing: true, builtinView: true, plainLocation: true, mode: "details", ...change })).toBe("none");
    });
  // One case per view mode × Folder Peek setting: column-flow List nests like
  // Details (#1240); Tiles panels show top-level folders only (#1241).
  it.each([
    ["details", true, "tree"], ["details", false, "none"],
    ["list", true, "tree"], ["list", false, "none"],
    ["tiles", true, "top-level"], ["tiles", false, "none"],
  ] as const)("%s with Folder Peek %s is %s", (mode, enabled, expected) => {
    expect(peekCapability({ enabled, fileListing: true, builtinView: true, plainLocation: true, mode })).toBe(expected);
  });
  it("disables resources for unsupported views and resolves commands and Escape", () => {
    const surface = { enabled: true, fileListing: true, builtinView: true, plainLocation: true, mode: "details" as const };
    expect(peekCapability(surface)).toBe("tree");
    expect(peekCapability({ ...surface, mode: "tiles" })).toBe("top-level");
    const tree = flatten();
    expect(resolvePeekCommandTarget(file, tree.meta)).toBe(nested.path);
    expect(resolvePeekCommandTarget(entry("/r/f", "file"), tree.meta)).toBeNull();
    // Tiles (top-level) peeks only the directory's own folders: a peeked
    // subfolder resolves to the peek holding it, like a file; none resolves nothing.
    expect(resolvePeekCommandTarget(nested, tree.meta, "top-level")).toBe(a.path);
    expect(resolvePeekCommandTarget(a, tree.meta, "top-level")).toBe(a.path);
    expect(resolvePeekCommandTarget(nested, tree.meta, "tree")).toBe(nested.path);
    expect(resolvePeekCommandTarget(a, tree.meta, "none")).toBeNull();
    expect(resolvePeekEscape(file, tree.meta)).toBe(nested.path);
    expect(resolvePeekEscape(a, tree.meta)).toBeNull();
  });
});

describe("memory kept while a folder stays expanded (Tiles panel sides)", () => {
  const expanded = new Map([["/r/a", 1], ["/r/b", 2], ["/r/c", 3]]);
  it("takes a layout's values and keeps expanded folders that layout did not place", () => {
    const before = new Map([["/r/a", "above"], ["/r/b", "below"]]);
    // Another directory's layout placed only c: a and b are still expanded.
    expect([...rememberWhileExpanded(before, new Map([["/r/c", "stacked"]]), expanded)]).toEqual([["/r/a", "above"], ["/r/b", "below"], ["/r/c", "stacked"]]);
    expect(rememberWhileExpanded(before, new Map([["/r/a", "below"]]), expanded).get("/r/a")).toBe("below");
  });
  it("forgets folders that left the expanded set, from memory or from the layout", () => {
    const before = new Map([["/r/a", "above"], ["/r/gone", "above"]]);
    expect([...rememberWhileExpanded(before, new Map([["/r/stale", "below"]]), expanded)]).toEqual([["/r/a", "above"]]);
    expect(rememberWhileExpanded(before, new Map(), new Map()).size).toBe(0);
  });
  it("returns the same map when nothing changed, so a store need not publish", () => {
    const before = new Map([["/r/a", "above"], ["/r/b", "below"]]);
    expect(rememberWhileExpanded(before, new Map([["/r/b", "below"]]), expanded)).toBe(before);
    expect(rememberWhileExpanded(before, new Map(), expanded)).toBe(before);
    expect(rememberWhileExpanded(before, new Map([["/r/b", "above"]]), expanded)).not.toBe(before);
  });
});
