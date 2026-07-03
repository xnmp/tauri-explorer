/**
 * E2E: Nano Banana image editing — now a built-in plugin (#144).
 *
 * Asserts the feature works entirely through plugin contributions: the
 * context-menu item and dialog come from the nano-banana plugin (enabled by
 * default), the Gemini API key lives in a plugin settings section, and
 * disabling the plugin removes the context-menu entry.
 */
import { test, expect, type Page } from "@playwright/test";
import { HOME_URL, waitForEntries, pressShortcut } from "./helpers";

async function openSettings(page: Page) {
  await pressShortcut(page, ",", { ctrlKey: true });
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  return dialog;
}

async function closeSettings(page: Page) {
  await page.locator(".settings-dialog .close-btn").click();
  await expect(page.locator(".settings-dialog")).toBeHidden();
}

async function setNanoBananaEnabled(page: Page, enabled: boolean) {
  const dialog = await openSettings(page);
  const row = dialog.locator('.setting-row:has-text("Nano Banana")').first();
  const toggle = row.locator('input[type="checkbox"]').first();
  await expect(toggle).toHaveCount(1);
  if ((await toggle.isChecked()) !== enabled) {
    await row.locator("label.toggle").click();
  }
  await expect(toggle).toBeChecked({ checked: enabled });
  await closeSettings(page);
}

async function rightClickImage(page: Page) {
  const imageEntry = page.locator(".entry-item").filter({ hasText: "image.png" }).first();
  await expect(imageEntry).toBeVisible({ timeout: 3000 });
  await imageEntry.click();
  await imageEntry.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible", timeout: 2000 });
  return menu;
}

test.describe("Nano Banana plugin", () => {
  test("context-menu item (plugin-contributed) opens the edit dialog for an image", async ({ page }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    const menu = await rightClickImage(page);

    // Contributed by the plugin (enabled by default).
    const nanoBananaItem = menu.locator('.menu-item:has-text("Edit with Nano Banana")');
    await expect(nanoBananaItem).toBeVisible();

    // Opens the plugin's dialog.
    await nanoBananaItem.click();
    const dialog = page.locator('[aria-labelledby="nano-banana-title"]');
    await expect(dialog).toBeVisible();

    // Real outcome: dialog shows the file and warns about the missing key.
    await expect(page.locator(".file-name")).toBeVisible();
    await expect(page.locator(".api-key-warning")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("disabling the plugin removes the context-menu entry", async ({ page }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    await setNanoBananaEnabled(page, false);

    const menu = await rightClickImage(page);
    await expect(menu.locator('.menu-item:has-text("Edit with Nano Banana")')).toHaveCount(0);

    // Re-enable to leave state clean and confirm it comes back.
    await page.keyboard.press("Escape");
    await setNanoBananaEnabled(page, true);
    const menu2 = await rightClickImage(page);
    await expect(menu2.locator('.menu-item:has-text("Edit with Nano Banana")')).toBeVisible();
  });

  test("Ctrl+J opens the jobs panel", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await pressShortcut(page, "j", { ctrlKey: true });
    await page.waitForTimeout(300);

    const panel = page.locator('[aria-labelledby="jobs-panel-title"]');
    await expect(panel).toBeVisible();

    const emptyState = page.locator(".empty-state");
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText("No background jobs");

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("settings has the plugin-contributed Gemini API Key field", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    const settingsDialog = await openSettings(page);

    const search = page.locator(".settings-search");
    await search.fill("Gemini");

    await expect(page.locator("text=Gemini API Key")).toBeVisible();
    const apiKeyInput = settingsDialog.locator('input[type="password"]');
    await expect(apiKeyInput).toBeVisible();
  });
});
