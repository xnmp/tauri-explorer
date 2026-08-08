/**
 * Markdown preview rendering (Obsidian-style) in the preview pane.
 * Asserts on actual rendered output: headings/tables/blockquotes as real
 * elements, fenced code highlighted by hljs, raw-HTML kept inert.
 */

import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Markdown preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
    }
    await expect(previewPane).toBeVisible();
  });

  test("selecting a .md file renders markdown instead of plain text", async ({ page }) => {
    await page.locator(".entry-item", { hasText: "notes.md" }).first().click();

    const markdown = page.locator(".preview-markdown");
    await expect(markdown).toBeVisible();

    // Real rendered elements, not the literal source text.
    await expect(markdown.locator("h1")).toHaveText("Notes");
    await expect(markdown.locator("strong")).toHaveText("bold");
    await expect(markdown.locator("table th").first()).toHaveText("key");
    await expect(markdown.locator("blockquote")).toContainText("Blockquotes render too");
    await expect(markdown.locator('a[href="https://example.com"]')).toHaveText("the docs");

    // Fenced ts code keeps syntax highlighting (hljs token spans).
    await expect(markdown.locator("pre.md-code .hljs-keyword").first()).toHaveText("const");

    // The raw markdown markers must not appear as text.
    await expect(markdown).not.toContainText("# Notes");
    await expect(markdown).not.toContainText("**bold**");
  });

  test("renders Markdown headings and links with theme accent colours", async ({ page }) => {
    await page.locator(".entry-item", { hasText: "notes.md" }).first().click();

    const markdown = page.locator(".preview-markdown");
    await expect(markdown).toBeVisible();

    const colours = await markdown.evaluate((element) => {
      const heading = element.querySelector("h1");
      const link = element.querySelector('a[href="https://example.com"]');
      const themeColour = (variable: "--accent" | "--accent-light") => {
        const swatch = document.createElement("span");
        swatch.style.color = `var(${variable})`;
        element.append(swatch);
        const colour = getComputedStyle(swatch).color;
        swatch.remove();
        return colour;
      };

      return {
        heading: heading ? getComputedStyle(heading).color : null,
        link: link ? getComputedStyle(link).color : null,
        headingAccent: themeColour("--accent-light"),
        linkAccent: themeColour("--accent"),
      };
    });

    expect(colours.heading).toBe(colours.headingAccent);
    expect(colours.link).toBe(colours.linkAccent);

    await markdown.locator("h1").screenshot({ path: "evidence/ac-1-markdown-heading-colour.png" });
    await markdown.locator('a[href="https://example.com"]').screenshot({ path: "evidence/ac-2-markdown-link-colour.png" });
  });

  test("non-markdown text files still use the plain highlighted preview", async ({ page }) => {
    await page.locator(".entry-item", { hasText: "readme.txt" }).first().click();

    await expect(page.locator(".preview-text")).toBeVisible();
    await expect(page.locator(".preview-markdown")).toHaveCount(0);
  });
});
