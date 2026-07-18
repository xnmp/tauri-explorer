/**
 * E2E test: selecting tile size options from command palette should switch to tiles view.
 * Issue: feat/palette-icon-view-switch
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Command palette icon view switch", () => {
  test("selecting tile size command switches view to tiles @smoke", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Verify we start in details view (default)
    await expect(page.locator(".details-view")).toBeVisible();

    // Open command palette with Ctrl+Shift+P
    await page.keyboard.press("Control+Shift+p");
    const palette = page.locator(".command-palette-dialog");
    await palette.waitFor({ state: "visible", timeout: 2000 });

    // Type to filter to the tile size command
    await palette.locator(".search-input").fill("Tile View: Set Size");
    await page.waitForTimeout(200);

    // Select the "Tile View: Set Size" command
    const cmd = palette.locator('.command-item:has-text("Tile View: Set Size")');
    await expect(cmd).toBeVisible();
    await cmd.click();

    // Palette closes and option picker opens
    await expect(palette).toBeHidden();
    const picker = page.locator(".option-picker-dialog");
    await expect(picker).toBeVisible({ timeout: 2000 });

    // Select "Medium" from the picker
    const mediumOption = picker.locator('.option-picker-item:has-text("Medium")');
    await mediumOption.click();

    // Picker should close and view should switch to tiles
    await expect(picker).toBeHidden();
    await expect(page.locator(".tiles-view")).toBeVisible({ timeout: 2000 });
  });
});
