/**
 * E2E test: language-specific file icons.
 * Issue: feat/language-icons
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Language-specific file icons", () => {
  test("file icons render for code files", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    // Verify file icons are present (icon-cat spans with language colors)
    const icons = page.locator(".icon-cat, .icon svg");
    await expect(icons.first()).toBeVisible();
  });
});
