import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test("selecting an HTML file renders its document in an isolated preview", async ({ page }) => {
  await page.goto("/?path=/home/html-preview");
  await waitForEntries(page);
  if (!(await page.locator(".preview-pane").isVisible())) await pressShortcut(page, " ");
  await expect(page.locator(".preview-pane")).toBeVisible();

  await page.locator('[data-path="/home/html-preview/preview.html"]').click();

  const preview = page.locator('iframe[title="HTML preview: preview.html"]');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("sandbox", "");

  const document = page.frameLocator('iframe[title="HTML preview: preview.html"]');
  await expect(document.getByRole("heading", { name: "Rendered HTML preview" })).toBeVisible();
  await expect(document.getByText("This document is rendered, not displayed as source.")).toBeVisible();
  await expect(page.locator(".preview-text")).toHaveCount(0);

  await page.screenshot({ path: "evidence/ac-1-html-preview-rendered.png" });

  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  await page.locator('[data-path="/home/user/readme.txt"]').click();
  await expect(page.locator(".preview-text")).toContainText("This is a readme file.");
  await expect(page.locator(".preview-html")).toHaveCount(0);
});
