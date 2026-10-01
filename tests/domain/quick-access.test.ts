/**
 * Quick Access default rows (#702).
 *
 * The sidebar used to fabricate these paths under a `/home` placeholder while
 * the real home directory query was still in flight, so a click landing in that
 * window navigated to a path that does not exist. The contract here is that an
 * unknown home yields rows that carry no target at all, so the section keeps its
 * shape without offering a link to nowhere.
 */
import { describe, expect, it } from "vitest";
import { buildQuickAccessFolders } from "../../src/lib/domain/quick-access";

describe("buildQuickAccessFolders", () => {
  it("offers no navigable target while the home directory is unknown", () => {
    for (const unknown of [null, undefined, "", "   "]) {
      const rows = buildQuickAccessFolders(unknown);
      expect(rows.map((f) => f.name)).toEqual(["Downloads", "Documents", "Pictures", "Videos", "Music"]);
      expect(rows.every((f) => f.path === null)).toBe(true);
    }
  });

  it("never derives a row from a root that is not the resolved home", () => {
    const paths = buildQuickAccessFolders("/home/user").map((f) => f.path);
    expect(paths).toContain("/home/user/Documents");
    expect(paths).not.toContain("/home/Documents");
  });

  it("places every default row directly under the resolved home directory", () => {
    expect(buildQuickAccessFolders("/home/user").map((f) => f.path)).toEqual([
      "/home/user/Downloads",
      "/home/user/Documents",
      "/home/user/Pictures",
      "/home/user/Videos",
      "/home/user/Music",
    ]);
  });

  it("keeps a Windows home all-backslash", () => {
    expect(buildQuickAccessFolders("C:\\Users\\chong").map((f) => f.path)).toEqual([
      "C:\\Users\\chong\\Downloads",
      "C:\\Users\\chong\\Documents",
      "C:\\Users\\chong\\Pictures",
      "C:\\Users\\chong\\Videos",
      "C:\\Users\\chong\\Music",
    ]);
  });

  it("does not double a separator when the home directory ends in one", () => {
    expect(buildQuickAccessFolders("/home/user/").map((f) => f.path)).toContain("/home/user/Documents");
    expect(buildQuickAccessFolders("C:\\").map((f) => f.path)).toContain("C:\\Documents");
  });

  it("tolerates a very long home path without truncating the row name", () => {
    const deep = `/home/${"a".repeat(4096)}`;
    const rows = buildQuickAccessFolders(deep);
    expect(rows).toHaveLength(5);
    expect(rows.map((f) => f.name)).toEqual(["Downloads", "Documents", "Pictures", "Videos", "Music"]);
    expect(rows[1]?.path).toBe(`${deep}/Documents`);
  });

  it("gives every row a name, icon and colour so the sidebar can render it", () => {
    for (const row of buildQuickAccessFolders("/home/user")) {
      expect(row.name).not.toBe("");
      expect(row.icon).not.toBe("");
      expect(row.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
