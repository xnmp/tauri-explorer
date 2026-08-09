import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Markdown preview colours", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
    }
    await expect(previewPane).toBeVisible();
  });

  test("renders headings and links with theme accent colours", async ({ page }) => {
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
  });
});
