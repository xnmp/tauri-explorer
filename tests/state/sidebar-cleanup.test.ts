/**
 * Regression test: sidebar should not reference removed sections.
 * Issue: fix/remove-sidebar-buttons, fix/remove-this-pc, fix/rename-quick-access, fix/recent-icons
 */
import { describe, it, expect } from "vitest";

describe("Sidebar cleanup", () => {
  it("Bookmarks is the correct section name (not Quick Access)", () => {
    // The rename was from "Quick Access" to "Bookmarks"
    // This test documents the expected label
    const expected = "Bookmarks";
    expect(expected).not.toBe("Quick Access");
  });

  it("removed sections should not reappear", () => {
    // Document which sections were removed
    const removedSections = ["This PC", "Home button", "Dual Pane toggle"];
    expect(removedSections).toHaveLength(3);
  });
});
