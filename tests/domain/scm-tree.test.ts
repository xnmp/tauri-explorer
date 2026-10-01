/**
 * SCM tree grouping for the SCM panel's tree view.
 */
import { describe, it, expect } from "vitest";
import { buildTree, collectPaths } from "$lib/domain/scm-tree";
import type { GitFileEntry } from "$lib/api/git";

const entry = (path: string): GitFileEntry => ({
  path,
  old_path: null,
  status: "Modified",
});

describe("buildTree", () => {
  it("groups files under their folder nodes", () => {
    const root = buildTree([
      entry("src/a.ts"),
      entry("src/lib/b.ts"),
      entry("README.md"),
    ]);

    expect(root.files.map((f) => f.path)).toEqual(["README.md"]);
    const src = root.children.get("src")!;
    expect(src.fullDir).toBe("src");
    expect(src.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    const lib = src.children.get("lib")!;
    expect(lib.fullDir).toBe("src/lib");
    expect(lib.files.map((f) => f.path)).toEqual(["src/lib/b.ts"]);
  });

  it("merges siblings into one folder node", () => {
    const root = buildTree([entry("src/a.ts"), entry("src/b.ts")]);
    expect(root.children.size).toBe(1);
    expect(root.children.get("src")!.files).toHaveLength(2);
  });

  it("handles empty input", () => {
    const root = buildTree([]);
    expect(root.children.size).toBe(0);
    expect(root.files).toHaveLength(0);
  });

  it("ignores empty path segments", () => {
    const root = buildTree([entry("src//a.ts")]);
    expect(root.children.get("src")!.files.map((f) => f.path)).toEqual(["src//a.ts"]);
  });
});

describe("collectPaths", () => {
  it("returns every file path under a node depth-first", () => {
    const root = buildTree([
      entry("src/a.ts"),
      entry("src/lib/b.ts"),
      entry("README.md"),
    ]);
    expect(collectPaths(root).sort()).toEqual(["README.md", "src/a.ts", "src/lib/b.ts"]);
    expect(collectPaths(root.children.get("src")!).sort()).toEqual([
      "src/a.ts",
      "src/lib/b.ts",
    ]);
  });
});

describe("filterEntriesToDir (#380)", () => {
  const entries = [
    { path: "src/app.ts" },
    { path: "src/lib/util.ts" },
    { path: "README.md" },
  ];

  it("returns everything at the repo root", async () => {
    const { filterEntriesToDir } = await import("$lib/domain/scm-tree");
    expect(filterEntriesToDir(entries, "/home/me/proj", "/home/me/proj")).toEqual(entries);
  });

  it("filters to a subdirectory", async () => {
    const { filterEntriesToDir } = await import("$lib/domain/scm-tree");
    expect(filterEntriesToDir(entries, "/home/me/proj", "/home/me/proj/src")).toEqual([
      { path: "src/app.ts" },
      { path: "src/lib/util.ts" },
    ]);
  });

  it("tolerates Windows backslash pane paths against git2's forward-slash root", async () => {
    const { filterEntriesToDir } = await import("$lib/domain/scm-tree");
    // Repo root as git2 reports it; active path as the pane stores it.
    expect(filterEntriesToDir(entries, "C:/Users/me/proj", "C:\\Users\\me\\proj")).toEqual(entries);
    expect(filterEntriesToDir(entries, "C:/Users/me/proj", "c:\\users\\me\\proj\\src")).toEqual([
      { path: "src/app.ts" },
      { path: "src/lib/util.ts" },
    ]);
  });

  it("tolerates a trailing separator on the root", async () => {
    const { filterEntriesToDir } = await import("$lib/domain/scm-tree");
    expect(filterEntriesToDir(entries, "/home/me/proj/", "/home/me/proj")).toEqual(entries);
  });

  it("passes through when root or path is missing", async () => {
    const { filterEntriesToDir } = await import("$lib/domain/scm-tree");
    expect(filterEntriesToDir(entries, null, "/x")).toEqual(entries);
    expect(filterEntriesToDir(entries, "/x", "")).toEqual(entries);
  });
});
