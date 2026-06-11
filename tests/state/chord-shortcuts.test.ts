/**
 * Chord shortcuts defined on real commands must use the Alt+M prefix and
 * parse with the chord parser that dispatches them at runtime.
 * Issue: fix/revert-chord-prefix
 */
import { describe, it, expect } from "vitest";
import { isChordShortcut, parseChord } from "$lib/domain/keybinding-parser";
// view-commands is deliberately not imported: it pulls sidebar-views.svelte.ts
// which imports real .svelte components, and component CSS preprocessing is
// unreliable in the Node test environment. Its chords follow the same Alt+M
// convention asserted here.
import {
  windowCommands,
  tabCommands,
  bookmarkCommands,
} from "$lib/state/commands/general-commands";
import { TOGGLE_SETTINGS } from "$lib/state/settings.svelte";

function collectShortcuts(): string[] {
  const fromCommands = [...windowCommands, ...tabCommands, ...bookmarkCommands]
    .map((c) => c.shortcut)
    .filter((s): s is string => typeof s === "string");
  const fromToggles = TOGGLE_SETTINGS.map((t) => t.shortcut).filter(
    (s): s is string => typeof s === "string",
  );
  return [...fromCommands, ...fromToggles];
}

describe("chord shortcuts (real definitions)", () => {
  const chords = collectShortcuts().filter(isChordShortcut);

  it("chord shortcuts exist in the command definitions", () => {
    expect(chords.length).toBeGreaterThan(0);
  });

  it("every chord uses the Alt+M prefix", () => {
    for (const chord of chords) {
      expect(chord.startsWith("Alt+M "), `${chord} should start with Alt+M`).toBe(true);
    }
  });

  it("every chord parses into a prefix and suffix", () => {
    for (const chord of chords) {
      const parsed = parseChord(chord);
      expect(parsed, `${chord} should parse`).not.toBeNull();
      expect(parsed!.prefix.alt, `${chord} prefix uses Alt`).toBe(true);
      expect(parsed!.prefix.key, `${chord} prefix key is m`).toBe("m");
    }
  });
});
