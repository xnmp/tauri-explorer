// Repository folders take the theme's `--icon-git-badge` as their whole folder
// colour (#1490, rendered by FolderIcon/FolderThumbnail/CatppuccinFileIcon in
// every view mode). Horizon aliased it to its accent, which is the same
// saturated red as `--system-critical`, so every repository read as an error
// (#1552). This contract keeps each built-in theme's Git tint away from its
// error red, distinct from ordinary folders, and visible on the window surface.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const THEMES_DIR = new URL("../../src/lib/themes/", import.meta.url);
const NON_THEME_FILES = new Set(["index.css", "syntax.css"]);
/** WCAG 1.4.11 non-text contrast for a graphical object. */
const NON_TEXT = 3;
/** Minimum hue separation from the error colour, in degrees. */
const MIN_HUE_FROM_CRITICAL = 20;

type Rgb = readonly [number, number, number];

function themeTokens(css: string, id: string): Map<string, string> {
  const block = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no [data-theme="${id}"] block`);
  return new Map([...block[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** Resolves `var(--x)` aliases within the theme block to an opaque hex colour. */
function color(tokens: Map<string, string>, name: string, seen = new Set<string>()): Rgb {
  const value = tokens.get(name);
  if (value === undefined || seen.has(name)) throw new Error(`--${name} is undefined or circular`);
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (alias) return color(tokens, alias[1], new Set([...seen, name]));
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`--${name} must be an opaque 6-digit hex colour, got ${value}`);
  return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

function hue([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function hueDistance(a: Rgb, b: Rgb): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

function luminance([r, g, b]: Rgb): number {
  const c = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes = readdirSync(THEMES_DIR)
  .filter((file) => file.endsWith(".css") && !NON_THEME_FILES.has(file))
  .map((file) => {
    const id = file.replace(/\.css$/, "");
    return { id, tokens: themeTokens(readFileSync(new URL(file, THEMES_DIR), "utf8"), id) };
  });

describe("repository folder Git tint", () => {
  it("covers the Horizon theme", () => {
    expect(themes.map((t) => t.id)).toContain("horizon");
  });

  describe.each(themes)("$id", ({ tokens }) => {
    it("is not the theme's error red", () => {
      const tint = color(tokens, "icon-git-badge");
      const critical = color(tokens, "system-critical");
      expect(tint).not.toEqual(critical);
      expect(hueDistance(tint, critical)).toBeGreaterThanOrEqual(MIN_HUE_FROM_CRITICAL);
    });

    it("stays distinct from ordinary folders", () => {
      expect(color(tokens, "icon-git-badge")).not.toEqual(color(tokens, "icon-folder"));
    });

    it("meets 3:1 against the window surface", () => {
      expect(contrast(color(tokens, "icon-git-badge"), color(tokens, "background-solid"))).toBeGreaterThanOrEqual(NON_TEXT);
    });
  });
});
