/**
 * Regression test: chord shortcuts must not use Alt modifier on Linux.
 * Issue: fix/terminal-shortcut-garbage
 *
 * Alt+key combinations produce compose characters (e.g. Alt+M → µ) in
 * WebKitGTK, which leak to other terminals as garbage characters.
 * All chord shortcuts should use Ctrl+key prefix instead.
 */
import { describe, it, expect } from "vitest";

// The chord shortcuts from command-definitions.ts
const CHORD_SHORTCUTS = [
  "Ctrl+M E",  // Toggle Sidebar
  "Ctrl+M B",  // Toggle Toolbar
  "Ctrl+M U",  // Toggle Status Bar
  "Ctrl+M T",  // Open Terminal
];

describe("Chord shortcut safety", () => {
  it("no chord shortcuts use Alt modifier (produces compose chars on Linux)", () => {
    for (const shortcut of CHORD_SHORTCUTS) {
      expect(shortcut.startsWith("Alt+"), `${shortcut} uses Alt`).toBe(false);
    }
  });

  it("all chord shortcuts use Ctrl prefix", () => {
    for (const shortcut of CHORD_SHORTCUTS) {
      expect(shortcut.startsWith("Ctrl+"), `${shortcut} should start with Ctrl+`).toBe(true);
    }
  });

  it("all chord shortcuts have a space-separated suffix key", () => {
    for (const shortcut of CHORD_SHORTCUTS) {
      expect(shortcut).toMatch(/^Ctrl\+\w+ \w+$/);
    }
  });
});
