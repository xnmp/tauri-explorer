// Theme-list dedupe (#585): a user theme reusing a built-in id used to
// produce duplicate ids in the picker's keyed each, crashing it mid-mount.
import { describe, expect, it } from "vitest";
import { dedupeThemesById } from "$lib/domain/theme-list";

const theme = (id: string, name: string) => ({ id, name });

describe("dedupeThemesById", () => {
  it("keeps the last occurrence of a duplicated id (user override wins)", () => {
    const result = dedupeThemesById([theme("nord", "Nord (built-in)"), theme("gruvbox", "Gruvbox"), theme("nord", "Nord (user)")]);

    expect(result.map((t) => t.id)).toEqual(["nord", "gruvbox"]);
    expect(result.find((t) => t.id === "nord")?.name).toBe("Nord (user)");
  });

  it("returns unique ids exactly once even with several duplicates", () => {
    const result = dedupeThemesById([theme("a", "1"), theme("a", "2"), theme("a", "3"), theme("b", "1"), theme("b", "2")]);

    expect(result).toEqual([theme("a", "3"), theme("b", "2")]);
  });

  it("passes through a list with no duplicates unchanged", () => {
    const input = [theme("light", "Light"), theme("dark", "Dark")];
    expect(dedupeThemesById(input)).toEqual(input);
  });

  it("handles an empty list", () => {
    expect(dedupeThemesById([])).toEqual([]);
  });
});
