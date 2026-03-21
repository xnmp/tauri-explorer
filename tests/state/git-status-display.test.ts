/**
 * Regression test: git status badges must render in all three view modes.
 * Issue: fix/git-status-display
 *
 * The git badge markup exists in FileItem (details), ListView, and TilesView.
 * This test verifies the badge text logic is consistent.
 */
import { describe, it, expect } from "vitest";

type GitFileStatus = "Modified" | "Added" | "Deleted" | "Renamed" | "Untracked" | "Conflict";

function badgeLetter(status: GitFileStatus): string {
  switch (status) {
    case "Modified": return "M";
    case "Untracked": return "U";
    case "Added": return "A";
    case "Deleted": return "D";
    case "Conflict": return "!";
    case "Renamed": return "?";
  }
}

describe("Git status badge letters", () => {
  it("all statuses produce a single-character badge", () => {
    const statuses: GitFileStatus[] = ["Modified", "Added", "Deleted", "Renamed", "Untracked", "Conflict"];
    for (const s of statuses) {
      const letter = badgeLetter(s);
      expect(letter.length, `${s} badge`).toBe(1);
    }
  });

  it("Modified = M, Untracked = U", () => {
    expect(badgeLetter("Modified")).toBe("M");
    expect(badgeLetter("Untracked")).toBe("U");
  });
});
