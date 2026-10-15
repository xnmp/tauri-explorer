import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

/** #1044: the scaled tile icons are 64px glyphs multiplied by displaySize/64.
 *  As flex items of a shrinking `.tile-icon` (48px at the small size) a bare
 *  folder SVG was flex-shrunk to 48px and then scaled again to 36px, while a
 *  linked folder (a span that cannot shrink below its content) stayed at 48px. */
function scaledIconRules(file: string): postcss.Rule[] {
  const source = readFileSync(resolve(process.cwd(), "src/lib/components", file), "utf8");
  const css = /<style[^>]*>([\s\S]*)<\/style>/.exec(source)![1];
  const rules: postcss.Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.includes(".tile-icon >") && rule.some((n) => n.type === "decl" && n.prop === "transform" && n.value.includes("var(--tile-icon-scale"))) {
      rules.push(rule);
    }
  });
  return rules;
}

describe("tile icon sizing", () => {
  for (const file of ["TileSurface.svelte", "InlineNewFolder.svelte"]) {
    it(`${file} keeps scaled icons from flex-shrinking before they are scaled`, () => {
      const rules = scaledIconRules(file);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        const shrink = rule.nodes.find((n): n is postcss.Declaration => n.type === "decl" && n.prop === "flex-shrink");
        expect(shrink?.value, rule.selector).toBe("0");
      }
    });
  }
});
