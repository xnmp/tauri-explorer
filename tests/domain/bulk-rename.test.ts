import { describe, expect, it } from "vitest";
import { bulkRenamePlan, type BulkRenamePattern } from "$lib/domain/bulk-rename";
import type { FileEntry } from "$lib/domain/file";

const entry = (path: string, kind: FileEntry["kind"] = "file"): FileEntry => ({ path, name: path.split(/[\\/]/).at(-1)!, kind, size: 1, modified: "" });
const pattern = (find: string, replace: string, options: Partial<BulkRenamePattern> = {}): BulkRenamePattern => ({ find, replace, regex: false, caseSensitive: false, ...options });

describe("bulk rename plan", () => {
  it("renames the name part only, keeping extensions and dotfiles intact", () => {
    const plan = bulkRenamePlan([entry("/r/photo1.jpg"), entry("/r/.photo"), entry("/r/Photo.tar.gz")], pattern("photo", "pic"), false);
    expect(plan.previews.map(p => p.renamed)).toEqual(["pic1.jpg", ".pic", "pic.tar.gz"]);
    expect(plan.changedCount).toBe(3);
  });
  it("honours case sensitivity and regex, and leaves names unchanged for an invalid regex", () => {
    const files = [entry("/r/Photo1.jpg"), entry("/r/photo2.jpg")];
    expect(bulkRenamePlan(files, pattern("photo", "x", { caseSensitive: true }), false).previews.map(p => p.renamed)).toEqual(["Photo1.jpg", "x2.jpg"]);
    expect(bulkRenamePlan(files, pattern("^p\\w+?(\\d)$", "img$1", { regex: true }), false).previews.map(p => p.renamed)).toEqual(["img1.jpg", "img2.jpg"]);
    const invalid = bulkRenamePlan(files, pattern("(", "x", { regex: true }), false);
    expect(invalid.changedCount).toBe(0);
    expect(invalid.operations).toEqual([]);
  });
  it("an empty pattern changes nothing", () => {
    expect(bulkRenamePlan([entry("/r/a.txt")], pattern("", "x"), false)).toMatchObject({ changedCount: 0, duplicates: [], operations: [] });
  });
  it("keys duplicate targets per folder, including unchanged selected names", () => {
    const peeked = [entry("/r/Alpha/same.txt"), entry("/r/Beta/same.txt")];
    expect(bulkRenamePlan(peeked, pattern("same", "other"), false).duplicates).toEqual([]);
    const siblings = [entry("/r/a1.txt"), entry("/r/a2.txt")];
    expect(bulkRenamePlan(siblings, pattern("\\d", "", { regex: true }), false).duplicates).toEqual(["a.txt"]);
    const ontoUnchanged = [entry("/r/a.txt"), entry("/r/b.txt")];
    expect(bulkRenamePlan(ontoUnchanged, pattern("b", "a"), false).duplicates).toEqual(["a.txt"]);
  });
  it("renames descendants before the folders that contain them", () => {
    const folder = entry("/r/Alpha", "directory"), child = entry("/r/Alpha/same.txt"), deep = entry("/r/Alpha/Nested/deep-a.txt"), other = entry("/r/Beta-a", "directory");
    const plan = bulkRenamePlan([folder, other, child, deep], pattern("a", "4"), false);
    expect(plan.operations.map(op => [op.entry.path, op.name])).toEqual([
      ["/r/Alpha/Nested/deep-a.txt", "deep-4.txt"],
      ["/r/Alpha/same.txt", "s4me.txt"],
      ["/r/Alpha", "4lph4"],
      ["/r/Beta-a", "Bet4-4"],
    ]);
  });
  it("orders Windows paths by native depth", () => {
    const plan = bulkRenamePlan([entry("C:\\r\\Alpha", "directory"), entry("C:\\r\\Alpha\\same.txt")], pattern("a", "4"), true);
    expect(plan.operations.map(op => op.entry.path)).toEqual(["C:\\r\\Alpha\\same.txt", "C:\\r\\Alpha"]);
  });
});
