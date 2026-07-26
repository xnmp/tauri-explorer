/**
 * Contract tests for the CSS custom-property resolver introduced with #499.
 *
 * The behaviour under test is "what would the browser compute for this value,
 * given this token table" — including the silent-degradation case that caused
 * the bug: a `var()` whose token is never defined.
 */
import { describe, it, expect } from "vitest";
import {
  collectCustomProperties,
  findDeclaredValue,
  resolveCssValue,
} from "$lib/domain/css-tokens";

const tokensOf = (pairs: Record<string, string>) => new Map(Object.entries(pairs));

describe("collectCustomProperties", () => {
  it("parses declarations out of a rule block", () => {
    const tokens = collectCustomProperties(":root { --a: 1px; --font-family: Inter, sans-serif; }");
    expect(tokens.get("--a")).toBe("1px");
    expect(tokens.get("--font-family")).toBe("Inter, sans-serif");
  });

  it("ignores ordinary properties", () => {
    expect(collectCustomProperties("a { color: red; }").size).toBe(0);
  });

  it("keeps the last declaration when a token is redefined", () => {
    expect(collectCustomProperties(":root{--a: 1;} :root{--a: 2;}").get("--a")).toBe("2");
  });

  it("returns an empty table for empty or token-free input", () => {
    expect(collectCustomProperties("").size).toBe(0);
  });

  it("ignores tokens that only appear inside a comment", () => {
    expect(collectCustomProperties("/* --a: 1; */ :root { --b: 2; }").has("--a")).toBe(false);
  });
});

describe("resolveCssValue", () => {
  it("substitutes a defined token", () => {
    expect(resolveCssValue("var(--f)", tokensOf({ "--f": "Inter" }))).toBe("Inter");
  });

  it("uses the fallback when the token is undefined — the #499 degradation", () => {
    expect(resolveCssValue("var(--font-mono, monospace)", new Map())).toBe("monospace");
  });

  it("prefers the defined token over the fallback", () => {
    expect(resolveCssValue("var(--f, monospace)", tokensOf({ "--f": "Inter" }))).toBe("Inter");
  });

  it("resolves an undefined token with no fallback to the empty string", () => {
    expect(resolveCssValue("var(--missing)", new Map())).toBe("");
  });

  it("resolves nested fallbacks", () => {
    expect(resolveCssValue("var(--a, var(--b, serif))", new Map())).toBe("serif");
    expect(resolveCssValue("var(--a, var(--b, serif))", tokensOf({ "--b": "Inter" }))).toBe("Inter");
  });

  it("resolves a token whose own value references another token", () => {
    expect(resolveCssValue("var(--a)", tokensOf({ "--a": "var(--b)", "--b": "Inter" }))).toBe("Inter");
  });

  it("resolves several references in one value", () => {
    expect(resolveCssValue("var(--a), var(--b)", tokensOf({ "--a": "Inter", "--b": "serif" }))).toBe(
      "Inter, serif",
    );
  });

  it("preserves a fallback stack containing commas", () => {
    expect(resolveCssValue('var(--x, "Segoe UI", Arial, sans-serif)', new Map())).toBe(
      '"Segoe UI", Arial, sans-serif',
    );
  });

  it("passes through values with no var() reference", () => {
    expect(resolveCssValue("  inherit  ", new Map())).toBe("inherit");
  });

  it("terminates on a cyclic token definition", () => {
    const cyclic = tokensOf({ "--a": "var(--b)", "--b": "var(--a)" });
    expect(() => resolveCssValue("var(--a)", cyclic)).not.toThrow();
  });

  it("leaves malformed var() syntax alone instead of throwing", () => {
    expect(resolveCssValue("var(--unclosed", new Map())).toBe("var(--unclosed");
    expect(resolveCssValue("var(notatoken)", new Map())).toBe("var(notatoken)");
  });
});

describe("findDeclaredValue", () => {
  const css = `
    .a { color: red; font-family: Inter; }
    .b, .c { font-family: serif; }
    .d { color: blue; }
  `;

  it("reads a property from a single-selector rule", () => {
    expect(findDeclaredValue(css, ".a", "font-family")).toBe("Inter");
  });

  it("matches a selector inside a comma-separated selector list", () => {
    expect(findDeclaredValue(css, ".c", "font-family")).toBe("serif");
  });

  it("returns null when the rule does not declare the property", () => {
    expect(findDeclaredValue(css, ".d", "font-family")).toBeNull();
  });

  it("returns null for an unknown selector", () => {
    expect(findDeclaredValue(css, ".nope", "font-family")).toBeNull();
  });

  it("does not match a selector that is merely a substring of another", () => {
    expect(findDeclaredValue(".file-path-extra { font-family: serif; }", ".file-path", "font-family")).toBeNull();
  });

  it("is not derailed by a comment quoting braces or declarations", () => {
    const commented = `
      /* .a { font-family: serif } — see the note above */
      .a { font-family: Inter; }
    `;
    expect(findDeclaredValue(commented, ".a", "font-family")).toBe("Inter");
  });

  it("takes the last declaration when a rule repeats the property", () => {
    expect(findDeclaredValue(".a { font-family: serif; font-family: Inter; }", ".a", "font-family")).toBe("Inter");
  });
});
