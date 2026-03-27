/**
 * E2E test: Nano Banana image editing integration.
 * Issue: feat/nano-banana
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries, pressShortcut } from "./helpers";

test.describe("Nano Banana integration", () => {
  test("context menu shows 'Edit with Nano Banana' for image files", async ({ page }) => {
    // Navigate to Downloads which has image.png in mock data
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    // Find and right-click the image.png file
    const imageEntry = page.locator(".entry-item").filter({ hasText: "image.png" }).first();
    await expect(imageEntry).toBeVisible({ timeout: 3000 });

    await imageEntry.click();
    await imageEntry.click({ button: "right" });

    const contextMenu = page.locator(".context-menu");
    await contextMenu.waitFor({ state: "visible", timeout: 2000 });

    // "Edit with Nano Banana" should appear
    const nanoBananaItem = contextMenu.locator('.menu-item:has-text("Edit with Nano Banana")');
    await expect(nanoBananaItem).toBeVisible();

    // Click it to open the dialog
    await nanoBananaItem.click();

    // Dialog should appear
    const dialog = page.locator('[aria-labelledby="nano-banana-title"]');
    await expect(dialog).toBeVisible();

    // Should show the file name
    const fileName = page.locator(".file-name");
    await expect(fileName).toBeVisible();

    // Should show API key warning (no key configured in test)
    const warning = page.locator(".api-key-warning");
    await expect(warning).toBeVisible();

    // Close via Escape
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Ctrl+J opens the jobs panel", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await pressShortcut(page, "j", { ctrlKey: true });
    await page.waitForTimeout(300);

    const panel = page.locator('[aria-labelledby="jobs-panel-title"]');
    await expect(panel).toBeVisible();

    // Should show empty state
    const emptyState = page.locator(".empty-state");
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText("No background jobs");

    // Close via Escape
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("settings dialog has Gemini API Key field", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Open settings
    await pressShortcut(page, ",", { ctrlKey: true });
    await page.waitForTimeout(500);

    const settingsDialog = page.locator(".settings-dialog");
    await expect(settingsDialog).toBeVisible();

    // Search for the API key setting
    const search = page.locator(".settings-search");
    await search.fill("Gemini");
    await page.waitForTimeout(300);

    // "Gemini API Key" should be visible
    await expect(page.locator("text=Gemini API Key")).toBeVisible();

    // The input should be a password field
    const apiKeyInput = settingsDialog.locator('input[type="password"]');
    await expect(apiKeyInput).toBeVisible();
  });
});
