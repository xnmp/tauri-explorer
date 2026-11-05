import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { PEEK_FILTER_MAX_DEPTH, peekFilterKeeps, scanReaches } from "$lib/domain/peek-filter";

const dir = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory", size: 0, modified: "" });
const file = (path: string): FileEntry => ({ ...dir(path), kind: "file" });

/** A tree from paths: every prefix becomes a folder, the leaf a file. */
function treeOf(...paths: string[]) {
  const listings = new Map<string, FileEntry[]>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const parent = "/" + parts.slice(0, i - 1).join("/");
      const child = "/" + parts.slice(0, i).join("/");
      const parentKey = parent === "/" ? "/" : parent;
      const siblings = listings.get(parentKey) ?? [];
      if (!siblings.some(entry => entry.path === child)) siblings.push(i === parts.length ? file(child) : dir(child));
      listings.set(parentKey, siblings);
      if (i < parts.length && !listings.has(child)) listings.set(child, []);
    }
  }
  return listings;
}
const named = (query: string) => (entry: FileEntry) => entry.name.includes(query);
function keeps(listings: Map<string, FileEntry[]>, query: string, maxDepth?: number) {
  return [...peekFilterKeeps({ entries: listings.get("/")!, listing: path => listings.get(path), matches: named(query), maxDepth })].sort();
}

describe("peekFilterKeeps (#1510)", () => {
  it("keeps a non-matching folder whose descendant matches, with every folder on the path", () => {
    const tree = treeOf("/a/b/target.txt", "/a/other.txt", "/c/none.txt");
    expect(keeps(tree, "target")).toEqual(["/a", "/a/b"]);
  });

  it("keeps nothing when no descendant matches", () => {
    expect(keeps(treeOf("/a/b/x.txt", "/c/y.txt"), "target")).toEqual([]);
  });

  it("respects the depth bound measured from the pane's listing", () => {
    expect(PEEK_FILTER_MAX_DEPTH).toBe(3);
    // target.txt is 3 levels below /a: found.
    expect(keeps(treeOf("/a/b/c/target.txt"), "target")).toEqual(["/a", "/a/b", "/a/b/c"]);
    // 4 levels below /a: past the bound, so nothing is kept.
    expect(keeps(treeOf("/a/b/c/d/target.txt"), "target")).toEqual([]);
    // A larger bound reaches it.
    expect(keeps(treeOf("/a/b/c/d/target.txt"), "target", 4)).toEqual(["/a", "/a/b", "/a/b/c", "/a/b/c/d"]);
  });

  it("gives nested folders the remaining budget only", () => {
    // /a/b sits one level down, so it may reach 2 more levels: d/target is 3 below b.
    const tree = treeOf("/a/b/c/d/target.txt", "/a/target-near.txt");
    expect(keeps(tree, "target")).toEqual(["/a"]);
  });

  it("counts a matching folder itself as a match", () => {
    expect(keeps(treeOf("/a/b/target/x.txt"), "target")).toEqual(["/a", "/a/b"]);
  });

  it("includes kept subfolders of a name-matching folder, for its peek", () => {
    expect(keeps(treeOf("/match/b/match.txt", "/match/c/no.txt"), "match")).toEqual(["/match", "/match/b"]);
  });

  it("proves nothing from an unknown listing", () => {
    const tree = treeOf("/a/b/target.txt");
    tree.delete("/a/b");
    expect(keeps(tree, "target")).toEqual([]);
  });

  it("scans folders only while they are within the bound", () => {
    expect([0, 1, 2, 3, 4].map(level => scanReaches(level))).toEqual([false, true, true, true, false]);
  });
});
