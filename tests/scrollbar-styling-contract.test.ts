/**
 * Scrollbar styling contract (#1920). The thumb is painted by one global
 * ::-webkit-scrollbar rule in +page.svelte that reads --scrollbar-* theme
 * tokens. Three things silently break it:
 * - `scrollbar-width` (other than `none`) or `scrollbar-color` on a scroller:
 *   Chromium 121+ (WebView2) then ignores every ::-webkit-scrollbar rule for
 *   that element and draws the native bar (recent WebKit may do the same).
 * - A second thumb rule elsewhere (Soft Cards had one) that outranks the
 *   global rule and pins one look for every theme.
 * - Resizing the bar (`::-webkit-scrollbar { width }`) elsewhere: the thumb's
 *   3px transparent border assumes the 8px gutter, so a narrower bar hides it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type Rule = "scrollbar-width" | "scrollbar-color" | "thumb-rule" | "bar-size";

interface Violation {
  line: number;
  rule: Rule;
}

/** Blank out CSS, HTML and line comments, keeping offsets and newlines. */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[\s;{}])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/**
 * Declarations in CSS, `style="…"`, `style:prop={…}` / `style:prop="…"`
 * directives, and DOM `el.style.scrollbarWidth = …` assignments.
 */
const PROPERTY = /(?<![\w-])scrollbar-(width|color)\s*[:=]\s*\{?\s*["'`]?\s*([\w-]+)/g;
const DOM_PROPERTY = /\.style\.scrollbar(Width|Color)\s*=\s*["'`]?\s*([\w-]+)/g;
const THUMB = /::-webkit-scrollbar-thumb/g;
const BAR_BLOCK = /::-webkit-scrollbar\b(?!-)[^{;]*\{([^}]*)\}/g;

function findScrollbarViolations(src: string, { owner = false } = {}): Violation[] {
  const text = stripComments(src);
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  const out: Violation[] = [];
  for (const re of [PROPERTY, DOM_PROPERTY]) {
    for (const m of text.matchAll(re)) {
      const prop = m[1].toLowerCase() as "width" | "color";
      if (prop === "width" && m[2] === "none") continue;
      out.push({ line: lineOf(m.index), rule: `scrollbar-${prop}` });
    }
  }
  if (!owner) {
    for (const m of text.matchAll(THUMB)) out.push({ line: lineOf(m.index), rule: "thumb-rule" });
    for (const m of text.matchAll(BAR_BLOCK)) {
      // Resizing breaks the thumb's inset; zero (hiding the bar) is fine.
      const sizes = [...m[1].matchAll(/(?:^|[\s;])(?:width|height|inline-size|block-size)\s*:\s*([^;}]+)/g)];
      if (sizes.some((d) => !/^0(?:px)?\s*(?:!important)?\s*$/.test(d[1].trim()))) out.push({ line: lineOf(m.index), rule: "bar-size" });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

describe("findScrollbarViolations", () => {
  it("allows hiding a scrollbar", () => {
    expect(findScrollbarViolations(".tabs { scrollbar-width: none; }")).toEqual([]);
    expect(findScrollbarViolations(".tabs { scrollbar-width:none!important }")).toEqual([]);
    expect(findScrollbarViolations(".tabs::-webkit-scrollbar { display: none; }")).toEqual([]);
  });

  it("flags thin/auto widths and any scrollbar-color", () => {
    expect(findScrollbarViolations(".a {\n  scrollbar-width: thin;\n}")).toEqual([{ line: 2, rule: "scrollbar-width" }]);
    expect(findScrollbarViolations(".a { scrollbar-width: auto }")).toHaveLength(1);
    expect(findScrollbarViolations(".a { scrollbar-color: red blue; }")).toEqual([{ line: 1, rule: "scrollbar-color" }]);
  });

  it("finds declarations in markup, directives and script", () => {
    expect(findScrollbarViolations('<div style="scrollbar-width: thin">')).toHaveLength(1);
    expect(findScrollbarViolations('<div style:scrollbar-width="thin">')).toHaveLength(1);
    expect(findScrollbarViolations("<div style:scrollbar-color={c}>")).toHaveLength(1);
    expect(findScrollbarViolations('el.style.scrollbarWidth = "thin";')).toHaveLength(1);
    expect(findScrollbarViolations('el.style.scrollbarWidth = "none";')).toEqual([]);
  });

  it("finds a value on the next line and a second declaration on one line", () => {
    expect(findScrollbarViolations(".a {\n  scrollbar-width:\n    thin;\n}")).toEqual([{ line: 2, rule: "scrollbar-width" }]);
    expect(findScrollbarViolations(".a { scrollbar-width: none; scrollbar-width: thin }")).toHaveLength(1);
  });

  it("flags thumb rules and bar resizing outside the global owner", () => {
    expect(findScrollbarViolations(":root ::-webkit-scrollbar-thumb { background: red; }")).toEqual([{ line: 1, rule: "thumb-rule" }]);
    expect(findScrollbarViolations(".a::-webkit-scrollbar { width: 4px; }")).toEqual([{ line: 1, rule: "bar-size" }]);
    expect(findScrollbarViolations(".a::-webkit-scrollbar { inline-size: 4px; }")).toHaveLength(1);
    expect(findScrollbarViolations(".a::-webkit-scrollbar { width: 0; height: 0 }")).toEqual([]);
    expect(findScrollbarViolations(":global(::-webkit-scrollbar-thumb) {}", { owner: true })).toEqual([]);
    expect(findScrollbarViolations(":global(::-webkit-scrollbar) { width: 8px; }", { owner: true })).toEqual([]);
  });

  it("allows track margins in layouts", () => {
    expect(findScrollbarViolations(":root ::-webkit-scrollbar-track:vertical { margin: 6px 0; }")).toEqual([]);
  });

  it("ignores comments and look-alike names", () => {
    expect(findScrollbarViolations("/* scrollbar-width: thin;\n ::-webkit-scrollbar-thumb */")).toEqual([]);
    expect(findScrollbarViolations("<!-- scrollbar-width: thin -->")).toEqual([]);
    expect(findScrollbarViolations("// scrollbar-color: red")).toEqual([]);
    expect(findScrollbarViolations(".a { --my-scrollbar-width: thin; }")).toEqual([]);
    expect(findScrollbarViolations("const scrollbarWidth = el.offsetWidth - el.clientWidth;")).toEqual([]);
    expect(findScrollbarViolations('const url = "https://example.com/scrollbar-width: thin";')).toHaveLength(1);
  });
});

const ROOT = join(__dirname, "..");
const OWNER = "src/routes/+page.svelte";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(css|svelte|ts|html)$/.test(name) ? [p] : [];
  });
}

describe("app sources", () => {
  it("leave scrollbar painting to the global token rule", () => {
    const violations = sourceFiles(join(ROOT, "src")).flatMap((file) => {
      const rel = relative(ROOT, file).split("\\").join("/");
      return findScrollbarViolations(readFileSync(file, "utf8"), { owner: rel === OWNER })
        .map((v) => `${rel}:${v.line} ${v.rule}`);
    });
    expect(violations).toEqual([]);
  });
});
