/**
 * Regression test for #499: the git graph's changed-files list rendered in a
 * different font than the rest of the app.
 *
 * Root cause: `.file-path` / `.file-status` declared
 * `font-family: var(--font-mono, monospace)`, and `--font-mono` is defined
 * nowhere in the codebase — so the declaration always resolved to the generic
 * `monospace` family while the rest of the UI renders in `var(--font-family)`.
 *
 * This test resolves the declarations the way the browser does, against the
 * token table parsed from the app's real `:root` block, reading the actual
 * shipped sources rather than a transcribed copy. The browser-level proof (the
 * computed typeface of rendered elements) lives in
 * `e2e/git-graph-changed-files-font.spec.ts`; this file guards the same
 * observable in the unit tier, where the whole class of bug — a `var()`
 * silently degrading to its fallback — is cheap to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  collectCustomProperties,
  findDeclaredValue,
  resolveCssValue,
} from "$lib/domain/css-tokens";

const repoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

const MONOSPACE = /\bmonospace\b|ui-monospace|Menlo|Consolas|Courier|SFMono/i;

/** `:root` tokens live in the app shell; component CSS resolves against them. */
const tokens = collectCustomProperties(repoFile("src/routes/+page.svelte"));
const graphCss = repoFile("src/lib/components/GitGraphView.svelte");

/** What `body { font-family }` actually computes to — the regular app font. */
const appFont = resolveCssValue(
  findDeclaredValue(repoFile("src/routes/+page.svelte"), ":global(body)", "font-family") ?? "",
  tokens,
);

function resolvedFontOf(selector: string): string {
  const declared = findDeclaredValue(graphCss, selector, "font-family");
  expect(declared, `${selector} should declare a font-family`).not.toBeNull();
  return resolveCssValue(declared as string, tokens);
}

describe("git graph changed-files font (#499)", () => {
  it("the app font is a real named stack, not a generic fallback", () => {
    expect(appFont).not.toBe("");
    expect(appFont).toContain("Inter");
    expect(appFont).not.toMatch(MONOSPACE);
  });

  it("file names in the changed-files list resolve to the regular app font", () => {
    const font = resolvedFontOf(".file-path");
    expect(font).toBe(appFont);
    expect(font).not.toMatch(MONOSPACE);
  });

  it("the status letter beside each file name resolves to the regular app font", () => {
    const font = resolvedFontOf(".file-status");
    expect(font).toBe(appFont);
    expect(font).not.toMatch(MONOSPACE);
  });

  it("inline diff content stays monospace", () => {
    // Guards the opposite failure: code lines must keep column alignment, so
    // the fix above must not have been applied across the whole panel.
    expect(resolvedFontOf(".diff-lines")).toMatch(MONOSPACE);
  });

  it("no changed-files rule depends on an undefined custom property", () => {
    // The actual defect class. `--font-mono` was referenced 9x and defined 0x;
    // any rule that resolves through a missing token is a silent degradation.
    for (const selector of [".file-path", ".file-status"]) {
      const declared = findDeclaredValue(graphCss, selector, "font-family") ?? "";
      for (const [, name] of declared.matchAll(/var\(\s*(--[\w-]+)/g)) {
        expect(tokens.has(name), `${selector} references undefined token ${name}`).toBe(true);
      }
    }
  });
});
