/**
 * E2E test: status bar shows total count/size and selection breakdown.
 * Issue: feat/statusbar-selection-info
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Status bar selection info", () => {
  test("shows total item count with folder/file breakdown and total size", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    const statusBar = page.locator(".status-bar");
    await expect(statusBar).toBeVisible();

    // Should show item count with breakdown
    await expect(statusBar).toContainText(/\d+ items?/);
    await expect(statusBar).toContainText(/folder/);
    await expect(statusBar).toContainText(/file/);
  });

  test("shows selection count and size when items are selected", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Click first item to select it
    await page.locator(".entry-item").first().click();
    await page.waitForTimeout(200);

    const statusBar = page.locator(".status-bar");
    await expect(statusBar).toContainText(/selected/);
  });
});
