/**
 * TeX math in Markdown previews (#1393): the typeset result is what matters,
 * not that the preview opened.
 */

import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Markdown math preview", () => {
  test("typesets inline and display math, leaving currency and code literal", async ({ page }) => {
    await page.goto("/?path=/home/math-preview");
    await waitForEntries(page);
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});
    await expect(previewPane).toBeVisible();

    await page.locator('[data-path="/home/math-preview/math.md"]').click();
    const markdown = page.locator(".preview-markdown");
    await expect(markdown.locator("h1")).toHaveText("Math");

    // Two inline formulas plus one display formula.
    await expect(markdown.locator(".katex")).toHaveCount(3);
    await expect(markdown.locator(".katex-display")).toHaveCount(1);
    await expect(markdown.locator(".katex-html").first()).toContainText("e");
    await expect(markdown.locator(".katex-display .katex-html")).toContainText("1");
    await expect(markdown.locator(".katex-display .mfrac, .katex-display .frac-line").first()).toBeAttached();

    // Currency and code spans are not math; delimiters never leak through.
    await expect(markdown).toContainText("it costs $5 and $10 in total");
    await expect(markdown.locator("code").first()).toHaveText("$x^2$");
    await expect(markdown.locator("pre.md-code")).toContainText("$$ not math $$");

    // Fonts are served from the bundle and actually load in the preview.
    const fontLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some((f) => f.family.startsWith("KaTeX") && f.status === "loaded");
    });
    expect(fontLoaded).toBe(true);

    // Display math scrolls inside the pane instead of widening it.
    const overflow = await markdown.locator(".md-math-block").evaluate((el) => getComputedStyle(el).overflowX);
    expect(overflow).toBe("auto");
  });
});
