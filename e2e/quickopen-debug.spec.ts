/**
 * E2E test: QuickOpen debug mode shows score breakdown.
 * Issue: feat/quickopen-debug, fix/quickopen-debug-settings
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("QuickOpen debug mode", () => {
  test("footer shows Alt+D hint", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    const footer = quickOpen.locator(".footer");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("Alt+D");
  });
});
