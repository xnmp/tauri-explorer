import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/directory-wire.json";
import { decodeDirectoryListing, type DirectoryListingPayload } from "$lib/api/directory-wire";

const decode = (value: unknown) => decodeDirectoryListing(value as DirectoryListingPayload);
const example = () => structuredClone(fixtures[0].wire);

describe("native directory transport", () => {
  it("restores the shared Rust contract without path normalization or metadata loss", () => {
    for (const { wire, listing } of fixtures) expect(decode(wire)).toEqual(listing);
  });

  it("keeps legacy immutable snapshots unchanged", () => {
    const listing = fixtures[0].listing;
    expect(decode(listing)).toBe(listing);
  });

  it("rejects a legacy-shaped listing with a malformed row instead of publishing it", () => {
    const base = fixtures[0].listing;
    const validEntry = base.entries[0];
    const badRows: unknown[] = [
      null,
      undefined,
      "not-an-entry",
      {}, // missing every field
      { ...validEntry, name: undefined },
      { ...validEntry, path: 42 },
      { ...validEntry, kind: "device" },
      { ...validEntry, size: -1 },
      { ...validEntry, size: 0.5 },
      { ...validEntry, modified: 12345 },
      { ...validEntry, is_symlink: "false" },
      { ...validEntry, symlink_target: 7 },
      { ...validEntry, is_empty: "false" },
      { ...validEntry, is_git_repo: "true" },
    ];
    for (const bad of badRows) {
      expect(() => decode({ path: base.path, entries: [validEntry, bad] })).toThrow(
        "Invalid native directory snapshot"
      );
    }
  });

  it("accepts a legacy-shaped listing whose rows are all valid", () => {
    const base = fixtures[0].listing;
    expect(decode({ path: base.path, entries: base.entries })).toEqual(base);
  });

  it("rejects malformed versions and columns instead of publishing partial entries", () => {
    const cases: unknown[] = [null, {}, { ...example(), format: "columns-v2", entries: [] }];
    for (const key of ["names", "kinds", "sizes", "modified", "is_symlink", "symlink_target", "is_empty", "is_git_repo"]) {
      const bad = example() as unknown as { columns: Record<string, unknown> };
      bad.columns[key] = [null];
      cases.push(bad);
    }
    for (const [key, value] of [["names", null], ["kinds", "device"], ["sizes", -1], ["sizes", 0.5], ["sizes", Infinity],
      ["modified", 0], ["is_symlink", null], ["is_git_repo", null], ["symlink_target", false], ["is_empty", "false"]] as const) {
      const bad = example() as unknown as { columns: Record<string, unknown[]> };
      bad.columns[key][0] = value;
      cases.push(bad);
    }
    cases.push({ ...example(), path_prefix: null }); // no full paths
    cases.push({ ...example(), columns: { ...example().columns, paths: ["/a", "/b", "/c"] } });
    for (const bad of cases) expect(() => decode(bad)).toThrow("Invalid native directory snapshot");
  });

  it("decodes a large listing completely and preserves its final row", () => {
    const count = 100_000;
    const names = Array.from({ length: count }, (_, i) => `entry-${i}`);
    const result = decode({ format: "columns-v1", path: "/requested", path_prefix: "/exact/", columns: {
      names, kinds: new Array(count).fill("file"), sizes: new Array(count).fill(0), modified: new Array(count).fill(""),
    } });
    expect(result.entries).toHaveLength(count);
    expect(result.entries.at(-1)).toMatchObject({ name: "entry-99999", path: "/exact/entry-99999", is_symlink: false, is_git_repo: false });
  });
});
