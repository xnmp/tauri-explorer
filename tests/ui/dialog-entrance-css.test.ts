import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Shared dialog chrome must open with a clip reveal: ending opacity or
 * transform animations under the blurred modal backdrop drops WebKitGTK
 * surfaces for a frame (#1080). Chromium e2e cannot see that dropout, so pin
 * the keyframe contract of the host-owned stylesheets directly. */
const COMPOSITED = /\b(opacity|transform|translate|scale|rotate|filter|backdrop-filter)\s*:/;

function keyframes(css: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const start = /@keyframes\s+([\w-]+)\s*\{/g;
  for (let match = start.exec(css); match; match = start.exec(css)) {
    let depth = 1;
    let index = start.lastIndex;
    while (depth > 0 && index < css.length) {
      if (css[index] === "{") depth++;
      else if (css[index] === "}") depth--;
      index++;
    }
    blocks.set(match[1], css.slice(start.lastIndex, index - 1));
  }
  return blocks;
}

/** Keyframes named by the `animation` of the top-level rule for `card`. */
function entrances(css: string, card: string): string[] {
  const rule = new RegExp(`(?:^|[};/])\\s*\\${card}\\s*\\{([^}]*)\\}`, "m").exec(css);
  const animation = rule ? /animation(?:-name)?\s*:\s*([^;]+);/.exec(rule[1]) : null;
  return animation ? animation[1].split(/,(?![^(]*\))/).map(part => part.trim().split(/\s+/)[0]) : [];
}

describe.each([
  ["src/lib/plugins/plugin-dialog.css", ".plugin-dialog"],
  ["src/lib/components/modal.css", ".modal-card"],
])("%s", (path, card) => {
  const css = readFileSync(path, "utf8");
  const names = entrances(css, card);

  it(`gives ${card} an entrance animation defined in the same file`, () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(keyframes(css).has(name)).toBe(true);
  });

  it("animates no composited property on entrance", () => {
    for (const name of names) expect(keyframes(css).get(name) ?? "").not.toMatch(COMPOSITED);
  });

  it("disables entrance motion for reduced-motion users", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*animation:\s*none/);
  });
});
