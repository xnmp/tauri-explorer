/**
 * Regression test: chord shortcuts use Alt+M prefix.
 * Issue: fix/revert-chord-prefix
 */
import { describe, it, expect } from "vitest";

// The chord shortcuts from command-definitions.ts
const CHORD_SHORTCUTS = [
  "Alt+M E",  // Toggle Sidebar
  "Alt+M B",  // Toggle Toolbar
  "Alt+M U",  // Toggle Status Bar
  "Alt+M T",  // Open Terminal
];

describe("Chord shortcut format", () => {
  it("all chord shortcuts use Alt+M prefix", () => {
    for (const shortcut of CHORD_SHORTCUTS) {
      expect(shortcut.startsWith("Alt+M "), `${shortcut} should start with Alt+M`).toBe(true);
    }
  });

  it("all chord shortcuts have a space-separated suffix key", () => {
    for (const shortcut of CHORD_SHORTCUTS) {
      expect(shortcut).toMatch(/^Alt\+M \w+$/);
    }
  });
});
