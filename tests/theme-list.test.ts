// Theme-list dedupe (#585): a user theme reusing a built-in id used to
// produce duplicate ids in the picker's keyed each, crashing it mid-mount.
import { describe, expect, it } from "vitest";
import { dedupeThemesById, resolveThemeId } from "$lib/domain/theme-list";

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

/**
 * Theme resolution (#599): config autoreload made hand-editing `"theme"` in
 * settings.json a live path, so an id that names nothing can now be applied
 * while the app is running — painting `data-theme="typo"`, which nothing
 * styles.
 */
describe("resolveThemeId", () => {
  const loaded = [theme("light", "Light"), theme("dark", "Dark"), theme("nord", "Nord")];

  it("keeps an id that names a loaded theme", () => {
    expect(resolveThemeId(loaded, "nord")).toBe("nord");
  });

  it("falls back to the first theme for an id nothing provides", () => {
    // A typo in a hand-edited settings.json, or a themes/*.css file deleted
    // while the app is running.
    expect(resolveThemeId(loaded, "nordd")).toBe("light");
    expect(resolveThemeId(loaded, "")).toBe("light");
  });

  it("trusts the request before discovery has run", () => {
    // An empty list means "not scanned yet", not "no such theme" — clobbering
    // the saved id here would lose it before the stylesheets are even read.
    expect(resolveThemeId([], "nord")).toBe("nord");
  });

  it("is idempotent, so a resolved id survives re-resolution", () => {
    // syncFromSettings compares the resolved id against the live one; if
    // resolving twice drifted, an unpersisted fallback would flap.
    const once = resolveThemeId(loaded, "gone");
    expect(resolveThemeId(loaded, once)).toBe(once);
  });
});
