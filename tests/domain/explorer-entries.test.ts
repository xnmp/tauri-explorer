import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { entriesLabel, withExternalEntry } from "$lib/domain/explorer-entries";

const entry = (name: string, dir = "/d"): FileEntry =>
  ({ name, path: `${dir}/${name}`, kind: "file", size: 0, modified: "2026-01-01T00:00:00Z" });

describe("entriesLabel", () => {
  it("names a single entry", () => {
    expect(entriesLabel([entry("a.txt")])).toBe("a.txt");
  });
  it("counts several or zero entries", () => {
    expect(entriesLabel([entry("a"), entry("b"), entry("c")])).toBe("3 items");
    expect(entriesLabel([])).toBe("0 items");
  });
});

describe("withExternalEntry", () => {
  const listed = [entry("a")];
  const external = entry("found", "/elsewhere");

  it("returns the listed entries without an external entry", () => {
    expect(withExternalEntry(listed, new Set(["/d/a"]), null)).toBe(listed);
  });
  it("appends a selected external entry", () => {
    expect(withExternalEntry(listed, new Set(["/d/a", external.path]), external)).toEqual([...listed, external]);
  });
  it("ignores an external entry that is no longer selected", () => {
    expect(withExternalEntry(listed, new Set(["/d/a"]), external)).toBe(listed);
  });
  it("does not duplicate an external entry the listing already holds", () => {
    const both = [...listed, external];
    expect(withExternalEntry(both, new Set([external.path]), external)).toBe(both);
  });
});
