/**
 * E2E: AI destination suggestions plugin (#158).
 *
 * Verifies the feature end-to-end through plugin contributions: the
 * context-menu item comes from the ai-organize plugin (enabled by default),
 * the picker renders ranked destinations from the (mocked) backend, and
 * choosing one MOVES the file via the normal transfer flow — the mock fs
 * persists the move, so the source listing loses the file.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";

async function setApiKey(page: Page, key: string) {
  await pressShortcut(page, ",", { ctrlKey: true });
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const section = dialog.locator(
    '.settings-section:has(h3:has-text("AI / Destination Suggestions"))',
  );
  const input = section.locator('.setting-row:has-text("Gemini API Key") input[type="password"]');
  await input.fill(key);
  await input.press("Tab");
  await dialog.locator(".close-btn").click();
  await expect(dialog).toBeHidden();
}

test.describe("AI destination suggestions", () => {
  test("suggests candidate folders and moves the file on accept", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await setApiKey(page, "test-key-123");

    // Right-click notes.md → the plugin's context item.
    const entry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
    await entry.click();
    await entry.click({ button: "right" });
    await page.locator(".context-menu").waitFor({ state: "visible", timeout: 3000 });
    await page.locator('.context-menu .menu-item:has-text("Suggest destination")').click();

    // The picker shows ranked destinations (mock returns the first
    // candidates: Documents' subfolder `project` leads the list).
    const dialog = page.locator('[aria-labelledby="ai-organize-title"]');
    await expect(dialog).toBeVisible();
    const suggestions = dialog.locator('[data-testid="ai-organize-suggestions"] .suggestion');
    await expect(suggestions.first()).toContainText("project");

    // Accept the top suggestion → the file moves out of Documents.
    await suggestions.first().click();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator(".entry-item").filter({ hasText: "notes.md" }),
    ).toHaveCount(0);

    // …and into project.
    await page
      .locator(".entry-item")
      .filter({ hasText: "project" })
      .first()
      .dblclick();
    await expect(
      page.locator(".entry-item").filter({ hasText: "notes.md" }).first(),
    ).toBeVisible();
  });

  test("without an API key the picker points to Settings", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    const entry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
    await entry.click();
    await entry.click({ button: "right" });
    await page.locator(".context-menu").waitFor({ state: "visible", timeout: 3000 });
    await page.locator('.context-menu .menu-item:has-text("Suggest destination")').click();

    const dialog = page.locator('[aria-labelledby="ai-organize-title"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("API key not configured");
    await expect(dialog.locator(".link-btn")).toContainText("Open Settings");
  });
});
