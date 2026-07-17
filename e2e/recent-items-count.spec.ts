/**
 * E2E test: configurable recent items count in sidebar.
 * Issue: feat/recent-items-count
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Recent items count setting", () => {
  test("settings dialog has recent items count input", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Open settings
    await page.keyboard.press("Control+,");

    // Check for the setting
    await expect(page.locator("text=Recent Items in Sidebar")).toBeVisible();
    await expect(page.locator(".setting-number")).toBeVisible();
  });
});
