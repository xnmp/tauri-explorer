// WCAG AA text contrast for every built-in theme (#785).
//
// The browser axe scan measures the surfaces the main window renders. This
// contract covers the token level for every theme, including tokens that only
// dialogs and panels paint, and keeps components from colouring text with a
// fill token that a theme cannot make legible.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const THEMES_DIR = new URL("../../src/lib/themes/", import.meta.url);
const SOURCE_DIR = new URL("../../src/", import.meta.url);
const NON_THEME_FILES = new Set(["index.css", "syntax.css"]);
const AA_TEXT = 4.5;

/** Fill tokens that themes may pair with a darker/lighter `-text` variant. */
const FILL_TOKENS = ["accent", "system-success", "system-caution", "system-critical"] as const;
const TEXT_TOKENS = ["text-primary", "text-secondary", "text-tertiary"] as const;

type Rgb = readonly [number, number, number];

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join("") : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Custom properties of a theme's primary `[data-theme="id"] { … }` block. */
function themeTokens(css: string, id: string): Map<string, string> {
  const block = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no [data-theme="${id}"] block`);
  return new Map([...block[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const themes = readdirSync(THEMES_DIR)
  .filter((file) => file.endsWith(".css") && !NON_THEME_FILES.has(file))
  .map((file) => {
    const id = file.replace(/\.css$/, "");
    return { id, tokens: themeTokens(readFileSync(new URL(file, THEMES_DIR), "utf8"), id) };
  });

function color(tokens: Map<string, string>, name: string): Rgb {
  const value = tokens.get(name);
  const rgb = value === undefined ? null : parseHex(value);
  if (!rgb) throw new Error(`--${name} must be an opaque hex colour, got ${value}`);
  return rgb;
}

function sourceFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) return sourceFiles(url);
    return /\.(svelte|css)$/.test(entry.name) ? [url] : [];
  });
}

describe("built-in theme text tokens", () => {
  it("finds every built-in theme", () => {
    expect(themes.length).toBeGreaterThanOrEqual(12);
  });

  describe.each(themes)("$id", ({ tokens }) => {
    const surface = () => color(tokens, "background-solid");

    it.each(TEXT_TOKENS)("--%s meets AA against the window surface", (token) => {
      expect(contrastRatio(color(tokens, token), surface())).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it.each(FILL_TOKENS)("text drawn in --%s meets AA against the window surface", (token) => {
      const textToken = tokens.has(`${token}-text`) ? `${token}-text` : token;
      expect(contrastRatio(color(tokens, textToken), surface())).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it("keeps secondary text distinguishable from tertiary text", () => {
      const ratio = (token: string) => contrastRatio(color(tokens, token), surface());
      expect(ratio("text-primary")).toBeGreaterThan(ratio("text-secondary"));
      expect(ratio("text-secondary")).toBeGreaterThan(ratio("text-tertiary"));
    });
  });
});

describe("component text colours", () => {
  it("draw fill tokens as text only through their -text variant", () => {
    const direct = new RegExp(
      String.raw`(?<![-a-z])color:\s*var\(--(${FILL_TOKENS.join("|")})[,)]`,
    );
    const offenders = sourceFiles(SOURCE_DIR)
      .filter((file) => !file.pathname.includes("/lib/themes/"))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            direct.test(line) ? [`${file.pathname.split("/src/").pop()}:${index + 1}`] : [],
          ),
      );
    expect(offenders).toEqual([]);
  });
});

describe("contrast helpers", () => {
  it("rejects malformed and translucent colours rather than guessing", () => {
    for (const value of ["", "#", "#12", "#12345", "#1234567", "red", "rgba(0,0,0,0.5)", "#ggg"]) {
      expect(parseHex(value)).toBeNull();
    }
  });

  it("matches the WCAG reference ratios", () => {
    expect(contrastRatio(parseHex("#000")!, parseHex("#fff")!)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseHex("#777777")!, parseHex("#ffffff")!)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(parseHex("#abc")!, parseHex("#abc")!)).toBe(1);
  });
});
