import { describe, expect, it } from "vitest";
import type { GitFileEntry } from "$lib/domain/git";
import {
  canCommitScm,
  canDiscardScmRow,
  discardableScmPaths,
  nextScmSelection,
  splitScmPath,
  statusClass,
  statusLetter,
  visibleScmRowPaths,
  visibleTreePaths,
} from "$lib/domain/scm-sidebar";

const entry = (path: string): GitFileEntry => ({ path, status: "Modified" }) as GitFileEntry;

describe("status badges", () => {
  it("maps every status code to a letter and class", () => {
    expect(statusLetter("Conflicted")).toBe("!");
    expect(statusLetter("TypeChange")).toBe("T");
    expect(statusClass("Untracked")).toBe("s-added");
    expect(statusClass("Copied")).toBe("s-renamed");
    expect(statusClass("Conflicted")).toBe("s-conflict");
  });
});

describe("splitScmPath", () => {
  it("separates the directory from the file name", () => {
    expect(splitScmPath("src/lib/a.ts")).toEqual({ dir: "src/lib", name: "a.ts" });
  });

  it("has no directory for a root-level file", () => {
    expect(splitScmPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("visibleTreePaths", () => {
  const rows = ["z.ts", "src/b.ts", "src/lib/c.ts", "docs/d.md"].map(entry);

  it("walks subfolders before a folder's own files", () => {
    const order = visibleTreePaths(rows, new Set());
    expect(order.indexOf("src/lib/c.ts")).toBeLessThan(order.indexOf("src/b.ts"));
    expect(order.at(-1)).toBe("z.ts");
    expect([...order].sort()).toEqual(rows.map((r) => r.path).sort());
  });

  it("skips files under a collapsed folder", () => {
    expect(visibleTreePaths(rows, new Set(["src"]))).not.toContain("src/lib/c.ts");
    expect(visibleTreePaths(rows, new Set(["src"]))).not.toContain("src/b.ts");
  });
});

describe("visibleScmRowPaths", () => {
  const staged = [entry("b/x.ts"), entry("a.ts")];
  const changes = [entry("c.ts")];

  it("follows section order and skips collapsed sections", () => {
    const sections = [
      { rows: staged, expanded: true },
      { rows: changes, expanded: false },
    ];
    expect(visibleScmRowPaths(sections, false, new Set())).toEqual(["b/x.ts", "a.ts"]);
  });

  it("uses tree order in tree view", () => {
    expect(visibleScmRowPaths([{ rows: staged, expanded: true }], true, new Set(["b"]))).toEqual(["a.ts"]);
  });
});

describe("nextScmSelection", () => {
  const rows = ["a", "b", "c"];

  it("starts at the first row going down and the last going up", () => {
    expect(nextScmSelection(rows, null, 1)).toBe("a");
    expect(nextScmSelection(rows, null, -1)).toBe("c");
    expect(nextScmSelection(rows, "gone", 1)).toBe("a");
  });

  it("steps and clamps at both ends", () => {
    expect(nextScmSelection(rows, "a", 1)).toBe("b");
    expect(nextScmSelection(rows, "c", 1)).toBe("c");
    expect(nextScmSelection(rows, "a", -1)).toBe("a");
  });

  it("selects nothing with no rows", () => {
    expect(nextScmSelection([], "a", 1)).toBeUndefined();
  });
});

describe("canCommitScm", () => {
  const ready = { isRepo: true, conflicted: 0, staged: 1, message: "fix", amend: false };

  it("needs a message and staged files", () => {
    expect(canCommitScm(ready)).toBe(true);
    expect(canCommitScm({ ...ready, message: "   " })).toBe(false);
    expect(canCommitScm({ ...ready, staged: 0 })).toBe(false);
  });

  it("allows amend without a message or staged files", () => {
    expect(canCommitScm({ ...ready, message: "", staged: 0, amend: true })).toBe(true);
  });

  it("blocks every commit outside a repo or with unresolved conflicts", () => {
    expect(canCommitScm({ ...ready, isRepo: false })).toBe(false);
    expect(canCommitScm({ ...ready, conflicted: 1, amend: true })).toBe(false);
  });
});

describe("Discard offers (#1619)", () => {
  const row = (path: string, status: GitFileEntry["status"]): GitFileEntry => ({ path, status }) as GitFileEntry;

  it("does not offer Discard on an intent-to-add row, which the backend refuses", () => {
    expect(canDiscardScmRow("changes", row("new.txt", "Added"))).toBe(false);
    expect(canDiscardScmRow("changes", row("a.txt", "Modified"))).toBe(true);
    expect(canDiscardScmRow("changes", row("d.txt", "Deleted"))).toBe(true);
    expect(canDiscardScmRow("untracked", row("u.txt", "Untracked"))).toBe(true);
    expect(canDiscardScmRow("staged", row("s.txt", "Modified"))).toBe(false);
    expect(canDiscardScmRow("merge", row("m.txt", "Conflicted"))).toBe(false);
  });

  it("leaves intent-to-add rows out of a folder batch instead of sinking it", () => {
    const rows = [row("dir/a.txt", "Modified"), row("dir/new.txt", "Added"), row("dir/d.txt", "Deleted")];
    expect(discardableScmPaths("changes", rows)).toEqual(["dir/a.txt", "dir/d.txt"]);
    expect(discardableScmPaths("changes", [row("dir/new.txt", "Added")])).toEqual([]);
  });
});
