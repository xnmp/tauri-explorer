/**
 * E2E test: selecting tile size options from command palette should switch to tiles view.
 * Issue: feat/palette-icon-view-switch
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Command palette icon view switch", () => {
  test("selecting tiles size command switches view to tiles", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Verify we start in details view (default)
    await expect(page.locator(".details-view")).toBeVisible();

    // Open command palette with Ctrl+Shift+P
    await page.keyboard.press("Control+Shift+p");
    const palette = page.locator(".command-palette-dialog");
    await palette.waitFor({ state: "visible", timeout: 2000 });

    // Type "tiles" to filter to tile commands
    await palette.locator(".search-input").fill("Tiles: Medium");
    await page.waitForTimeout(200);

    // Select the "Tiles: Medium Icons" command
    const mediumCmd = palette.locator('.command-item:has-text("Tiles: Medium Icons")');
    await expect(mediumCmd).toBeVisible();
    await mediumCmd.click();

    // Palette should close and view should switch to tiles
    await expect(palette).toBeHidden();
    await expect(page.locator(".tiles-view")).toBeVisible({ timeout: 2000 });
  });
});
