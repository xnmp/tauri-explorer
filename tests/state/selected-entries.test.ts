import { describe, expect, it } from "vitest";
import { SvelteSet } from "svelte/reactivity";
import { getSelectedEntries } from "$lib/state/selection";
import type { FileEntry } from "$lib/domain/file";

const entry = (name: string): FileEntry =>
  ({ name, path: `/d/${name}`, kind: "file", size: 1, modified: "", is_symlink: false, is_git_repo: false });

describe("getSelectedEntries", () => {
  const entries = ["c", "a", "b", "d"].map(entry);

  it("returns selected entries in display order, not selection order", () => {
    expect(getSelectedEntries(entries, new Set(["/d/d", "/d/c", "/d/b"])).map((e) => e.name)).toEqual(["c", "b", "d"]);
  });

  it("reads a reactive set and ignores paths that are not displayed", () => {
    const selected = new SvelteSet(["/d/a", "/elsewhere/x"]);
    expect(getSelectedEntries(entries, selected)).toEqual([entries[1]]);
  });

  it("returns nothing for an empty selection or listing", () => {
    expect(getSelectedEntries(entries, new Set())).toEqual([]);
    expect(getSelectedEntries([], new Set(["/d/a"]))).toEqual([]);
  });
});
