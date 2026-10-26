import { describe, expect, it } from "vitest";
import { COMMAND_KEYWORDS, keywordsFor } from "$lib/domain/command-keywords";

describe("keywordsFor", () => {
  it("returns lowercased synonyms, and [] for unknown commands", () => {
    expect(keywordsFor("general.openKeybindings")).toContain("hotkeys");
    expect(keywordsFor("no.such.command")).toBe("");
    for (const list of Object.values(COMMAND_KEYWORDS)) {
      expect(list.length).toBeGreaterThan(0);
    }
  });
});
