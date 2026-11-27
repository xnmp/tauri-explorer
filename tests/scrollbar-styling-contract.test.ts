/**
 * Scrollbar styling contract (#1920). The thumb is painted by one global
 * ::-webkit-scrollbar rule in +page.svelte that reads --scrollbar-* theme
 * tokens. Two things silently break it:
 * - `scrollbar-width` (other than `none`) or `scrollbar-color` on a scroller:
 *   Chromium 121+ (WebView2) then ignores every ::-webkit-scrollbar rule for
 *   that element, so it shows the native bar on Windows only.
 * - A second thumb rule elsewhere (Soft Cards had one) that outranks the
 *   global rule and pins one look for every theme.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

interface Violation {
  line: number;
  rule: string;
}

function stripComments(src: string): string {
  // Keep newlines so reported line numbers stay right.
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function findScrollbarViolations(src: string, { allowThumbRules = false } = {}): Violation[] {
  const out: Violation[] = [];
  stripComments(src).split("\n").forEach((text, i) => {
    const width = /(?:^|[\s;{])scrollbar-width\s*:\s*([^;}\s]+)/.exec(text);
    if (width && width[1] !== "none") out.push({ line: i + 1, rule: "scrollbar-width" });
    if (/(?:^|[\s;{])scrollbar-color\s*:/.test(text)) out.push({ line: i + 1, rule: "scrollbar-color" });
    if (!allowThumbRules && /::-webkit-scrollbar-thumb/.test(text)) out.push({ line: i + 1, rule: "thumb-rule" });
  });
  return out;
}

describe("findScrollbarViolations", () => {
  it("allows hiding a scrollbar", () => {
    expect(findScrollbarViolations(".tabs { scrollbar-width: none; }")).toEqual([]);
  });

  it("flags thin/auto widths and any scrollbar-color", () => {
    expect(findScrollbarViolations(".a {\n  scrollbar-width: thin;\n}")).toEqual([{ line: 2, rule: "scrollbar-width" }]);
    expect(findScrollbarViolations(".a { scrollbar-width: auto }")).toHaveLength(1);
    expect(findScrollbarViolations(".a { scrollbar-color: red blue; }")).toEqual([{ line: 1, rule: "scrollbar-color" }]);
  });

  it("flags thumb rules outside the global owner", () => {
    expect(findScrollbarViolations(":root ::-webkit-scrollbar-thumb { background: red; }")).toEqual([{ line: 1, rule: "thumb-rule" }]);
    expect(findScrollbarViolations(":global(::-webkit-scrollbar-thumb) {}", { allowThumbRules: true })).toEqual([]);
  });

  it("ignores comments and look-alike property names", () => {
    expect(findScrollbarViolations("/* scrollbar-width: thin;\n ::-webkit-scrollbar-thumb */")).toEqual([]);
    expect(findScrollbarViolations(".a { --my-scrollbar-width: thin; }")).toEqual([]);
  });
});

const ROOT = join(__dirname, "..");
const THUMB_OWNER = "src/routes/+page.svelte";

function styleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return styleFiles(p);
    return /\.(css|svelte)$/.test(name) ? [p] : [];
  });
}

describe("app stylesheets", () => {
  it("leave scrollbar painting to the global token rule", () => {
    const violations = styleFiles(join(ROOT, "src")).flatMap((file) => {
      const rel = relative(ROOT, file).split("\\").join("/");
      return findScrollbarViolations(readFileSync(file, "utf8"), { allowThumbRules: rel === THUMB_OWNER })
        .map((v) => `${rel}:${v.line} ${v.rule}`);
    });
    expect(violations).toEqual([]);
  });
});
