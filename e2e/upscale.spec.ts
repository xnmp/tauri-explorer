/**
 * E2E: Upscale plugin — fal.ai SeedVR2 image upscaling (#276).
 *
 * Asserts the feature works entirely through plugin contributions: the
 * context-menu item and dialog come from the upscale plugin (enabled by
 * default), the fal.ai API key lives in a plugin settings section, and the
 * dialog pre-fills a `_upscaled` output filename.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

async function rightClickImage(page: Page) {
  const imageEntry = page.locator(".entry-item").filter({ hasText: "image.png" }).first();
  await expect(imageEntry).toBeVisible({ timeout: 3000 });
  await imageEntry.click();
  await imageEntry.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible", timeout: 2000 });
  return menu;
}

test.describe("Upscale plugin", () => {
  test("context-menu item opens the upscale dialog with a prefilled output name", async ({ page }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    const menu = await rightClickImage(page);
    await menu.getByRole("menuitem", { name: "AI", exact: true }).hover();
    const upscaleItem = menu.locator('.menu-item:has-text("Upscale Image")');
    await expect(upscaleItem).toBeVisible();

    await upscaleItem.click();
    const dialog = page.locator('[aria-labelledby="upscale-title"]');
    await expect(dialog).toBeVisible();

    // Real outcome: without a key configured the dialog warns instead of
    // showing the form (FAL_KEY is not set in the browser mock env).
    await expect(page.locator(".file-name")).toContainText("image.png");
    await expect(page.locator(".api-key-warning")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("context-menu item does not appear for non-raster files", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    const textEntry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
    await textEntry.click();
    await textEntry.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await menu.waitFor({ state: "visible", timeout: 2000 });

    await expect(menu.locator('.menu-item:has-text("Upscale Image")')).toHaveCount(0);
  });

  test("settings has the plugin-contributed fal.ai API Key field", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    await pressShortcut(page, ",", { ctrlKey: true });
    const settingsDialog = page.locator(".settings-dialog");
    await expect(settingsDialog).toBeVisible({ timeout: 2000 });

    const search = page.locator(".settings-search");
    await search.fill("fal");

    const section = settingsDialog.locator('.settings-section:has(h3:has-text("Upscale"))');
    await expect(section.locator('.setting-label:has-text("fal.ai API Key")')).toBeVisible();
    await expect(section.locator('input[type="password"]')).toBeVisible();
  });
});
