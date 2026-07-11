/**
 * Bulk rename dialog behaviour (find/replace pattern rename).
 * Issue: test/e2e-coverage-tier1
 *
 * The dialog (BulkRenameDialog.svelte) applies a find/replace to the name
 * part only (extension preserved), shows a live preview of the resulting
 * names, and refuses to run when two files would collide onto one name.
 *
 * Fixtures: /home/user/Pictures contains photo1.jpg, photo2.jpg,
 * screenshot.png and a vacation/ folder.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries, MULTI_SELECT_MODIFIER } from "./helpers";

const PICTURES_URL = "/?path=/home/user/Pictures";

/** Select two file entries by name (first click, then modifier-click). */
async function selectTwo(page: Page, first: string, second: string): Promise<void> {
  await page.locator(".entry-item", { hasText: first }).first().click();
  await page.locator(".entry-item", { hasText: second }).first().click({
    modifiers: [MULTI_SELECT_MODIFIER],
  });
  await expect(page.locator(".entry-item.selected")).toHaveCount(2);
}

/** Open the Bulk Rename dialog for the current selection via the command palette. */
async function openBulkRename(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.waitFor({ state: "visible", timeout: 2000 });
  await palette.locator(".search-input").fill("Bulk Rename");
  const cmd = palette.locator('.command-item:has-text("Bulk Rename")');
  await expect(cmd).toBeVisible();
  await cmd.click();
  await expect(page.locator(".dialog", { hasText: "Bulk Rename" })).toBeVisible({ timeout: 2000 });
}

test.describe("Bulk rename", () => {
  test("pattern rename replaces the names in the list", async ({ page }) => {
    await page.goto(PICTURES_URL);
    await waitForEntries(page);
    await selectTwo(page, "photo1.jpg", "photo2.jpg");
    await openBulkRename(page);

    await page.locator('input[placeholder="Text to find..."]').fill("photo");
    await page.locator('input[placeholder="Replacement..."]').fill("picture");

    // Confirm the rename.
    await page.locator(".dialog .btn-primary").click();

    // The dialog closes and the new names are in the list; old ones are gone.
    await expect(page.locator(".dialog", { hasText: "Bulk Rename" })).toHaveCount(0);
    await expect(page.locator(".entry-item .entry-name", { hasText: "picture1.jpg" })).toBeVisible();
    await expect(page.locator(".entry-item .entry-name", { hasText: "picture2.jpg" })).toBeVisible();
    await expect(page.locator(".entry-item .entry-name", { hasText: "photo1.jpg" })).toHaveCount(0);
    await expect(page.locator(".entry-item .entry-name", { hasText: "photo2.jpg" })).toHaveCount(0);
  });

  test("live preview shows the resulting names before confirming", async ({ page }) => {
    await page.goto(PICTURES_URL);
    await waitForEntries(page);
    await selectTwo(page, "photo1.jpg", "photo2.jpg");
    await openBulkRename(page);

    await page.locator('input[placeholder="Text to find..."]').fill("photo");
    await page.locator('input[placeholder="Replacement..."]').fill("picture");

    // Preview updates live — before any confirmation.
    const renamed = page.locator(".preview-row.changed .renamed-name");
    await expect(renamed).toHaveCount(2);
    await expect(renamed.nth(0)).toHaveText("picture1.jpg");
    await expect(renamed.nth(1)).toHaveText("picture2.jpg");
    await expect(page.locator(".change-count")).toHaveText("2 files will be renamed");

    // Nothing has actually changed on disk yet.
    await page.locator(".dialog .btn-secondary").click();
    await expect(page.locator(".entry-item .entry-name", { hasText: "photo1.jpg" })).toBeVisible();
  });

  test("a colliding pattern is blocked, not applied", async ({ page }) => {
    await page.goto(PICTURES_URL);
    await waitForEntries(page);
    await selectTwo(page, "photo1.jpg", "photo2.jpg");
    await openBulkRename(page);

    // Regex `photo\d` maps both photo1 and photo2 to the same name "pic".
    await page.locator('label:has-text("Regex") input[type="checkbox"]').check();
    await page.locator('input[placeholder="Text to find..."]').fill("photo\\d");
    await page.locator('input[placeholder="Replacement..."]').fill("pic");

    // The dialog surfaces the collision and disables the Rename button
    // (this is the designed behaviour — it refuses to clobber).
    await expect(page.locator(".dialog .error-msg")).toContainText("same name");
    await expect(page.locator(".dialog .btn-primary")).toBeDisabled();

    // Escape out; the original files are untouched.
    await page.locator(".dialog .btn-secondary").click();
    await expect(page.locator(".entry-item .entry-name", { hasText: "photo1.jpg" })).toBeVisible();
    await expect(page.locator(".entry-item .entry-name", { hasText: "photo2.jpg" })).toBeVisible();
    await expect(page.locator(".entry-item .entry-name", { hasText: "pic.jpg" })).toHaveCount(0);
  });
});
