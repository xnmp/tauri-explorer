/**
 * E2E test: git status indicators feature.
 * Issue: feat/git-status-indicators
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Git status indicators", () => {
  test("settings dialog has git status toggle", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Open settings
    await page.keyboard.press("Control+,");
    const dialog = page.locator(".settings-dialog, .dialog-overlay");
    await dialog.waitFor({ state: "visible", timeout: 2000 });

    // Check for git status toggle
    await expect(page.locator("text=Git Status Indicators")).toBeVisible();
  });
});
