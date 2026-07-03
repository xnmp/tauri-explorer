/**
 * Screenshot capture for #145: the AI rename suggestion picker open over a file,
 * showing the proposed names. Asserts the suggestions are visible before
 * capturing. Run with:
 *   bunx playwright test e2e/ai-rename-screenshot.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries, HOME_URL, pressShortcut } from "./helpers";
import { mkdirSync } from "node:fs";

const DIR = "screenshots/feat/plugin-ai-rename-suggestions";

async function setApiKey(page: Page, key: string) {
  await pressShortcut(page, ",", { ctrlKey: true });
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const section = dialog.locator('.settings-section:has(h3:has-text("AI / Rename Suggestions"))');
  const input = section.locator('.setting-row:has-text("Gemini API Key") input[type="password"]');
  await input.fill(key);
  await input.press("Tab");
  await dialog.locator(".close-btn").click();
  await expect(dialog).toBeHidden();
}

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

test.beforeEach(async ({ page }) => {
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.goto(HOME_URL);
  await waitForEntries(page);
});

test("suggestion picker shows proposed names", async ({ page }) => {
  await setApiKey(page, "test-key-123");

  const entry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
  await entry.click();
  await entry.click({ button: "right" });
  await page.locator(".context-menu").waitFor({ state: "visible", timeout: 3000 });
  await page.locator('.context-menu .menu-item:has-text("Suggest rename")').click();

  const dialog = page.locator('[aria-labelledby="ai-rename-title"]');
  await expect(dialog).toBeVisible();
  const suggestions = dialog.locator('[data-testid="ai-rename-suggestions"] .suggestion');
  // Assert the picker genuinely shows the proposed names before capturing.
  await expect(suggestions).toHaveCount(3);
  await expect(suggestions.first()).toContainText("meeting-notes.md");

  await page.screenshot({ path: `${DIR}/suggestion-picker.png` });
});
