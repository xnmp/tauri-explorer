/**
 * E2E test: settings search filter.
 * Issue: feat/settings-search
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Settings search filter", () => {
  test("filtering settings shows only matching rows", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Open settings
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(500);

    // Type in search
    const search = page.locator(".settings-search");
    await expect(search).toBeVisible();
    await search.fill("hidden");
    await page.waitForTimeout(300);

    // "Show Hidden Files" should be visible
    await expect(page.locator("text=Show Hidden Files")).toBeVisible();

    // "Theme" should be hidden
    const themeRow = page.locator(".setting-row:has-text('Choose the color theme')");
    await expect(themeRow).toBeHidden();
  });
});
