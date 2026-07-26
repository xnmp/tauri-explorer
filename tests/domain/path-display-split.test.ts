/**
 * Contract for `splitPathForDisplay` (#500).
 *
 * The helper exists so a long changed-file path can be rendered as two
 * differently-truncating halves on a single line. Its whole reason to be a
 * *partition* rather than a normalization is the round-trip invariant: the two
 * halves concatenated must equal the input, so the text the user sees (and the
 * text existing specs match on) is unchanged by the split.
 *
 * These tests assert that contract and the edge cases, never the internals.
 */
import { describe, it, expect } from "vitest";
import { splitPathForDisplay } from "../../src/lib/domain/path";

/** Every case below is also checked against the round-trip invariant. */
const CASES: Array<{ label: string; path: string; dir: string; name: string }> = [
  {
    label: "an ordinary repo-relative path",
    path: "src/lib/app.ts",
    dir: "src/lib/",
    name: "app.ts",
  },
  {
    label: "a bare file name with no directory",
    path: "README.md",
    dir: "",
    name: "README.md",
  },
  {
    label: "the empty string",
    path: "",
    dir: "",
    name: "",
  },
  {
    label: "a single leading separator",
    path: "/etc",
    dir: "/",
    name: "etc",
  },
  {
    label: "a trailing separator (the final segment is empty)",
    path: "src/lib/",
    dir: "src/lib/",
    name: "",
  },
  {
    label: "consecutive separators",
    path: "src//lib//app.ts",
    dir: "src//lib//",
    name: "app.ts",
  },
  {
    label: "a dot-file",
    path: "config/.gitignore",
    dir: "config/",
    name: ".gitignore",
  },
  {
    label: "a lone dot-file at the root of the repo",
    path: ".gitignore",
    dir: "",
    name: ".gitignore",
  },
  {
    label: "a backslash, which git reports as part of the name and not a separator",
    path: "src/weird\\name.ts",
    dir: "src/",
    name: "weird\\name.ts",
  },
  {
    label: "a name that is only separators",
    path: "///",
    dir: "///",
    name: "",
  },
  {
    label: "a path whose final segment holds the non-ASCII characters",
    path: "docs/日本語/読み方.md",
    dir: "docs/日本語/",
    name: "読み方.md",
  },
];

describe("splitPathForDisplay (#500)", () => {
  for (const c of CASES) {
    it(`splits ${c.label}`, () => {
      expect(splitPathForDisplay(c.path)).toEqual({ dir: c.dir, name: c.name });
    });
  }

  it("round-trips: dir + name reconstructs the input exactly, for every case", () => {
    for (const c of CASES) {
      const { dir, name } = splitPathForDisplay(c.path);
      expect(dir + name).toBe(c.path);
    }
  });

  it("round-trips a pathologically long path without truncating or normalizing it", () => {
    // The rendering layer elides visually; the data must stay intact, or the
    // tooltip and the row's text content would lie about what changed.
    const long = `${"a-very-long-directory-segment/".repeat(200)}${"n".repeat(2000)}.ts`;
    expect(long.length).toBeGreaterThan(4000);

    const { dir, name } = splitPathForDisplay(long);
    expect(dir + name).toBe(long);
    expect(name).toBe(`${"n".repeat(2000)}.ts`);
  });

  it("never emits a name containing a separator", () => {
    for (const c of CASES) {
      expect(splitPathForDisplay(c.path).name).not.toContain("/");
    }
  });
});
