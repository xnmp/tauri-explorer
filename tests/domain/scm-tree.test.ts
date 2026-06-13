/**
 * SCM tree grouping for the SCM panel's tree view.
 */
import { describe, it, expect } from "vitest";
import { buildTree, collectPaths } from "$lib/domain/scm-tree";
import type { GitFileEntry } from "$lib/api/files";

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
