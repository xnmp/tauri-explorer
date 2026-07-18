/**
 * E2E: AI rename suggestions plugin (#145).
 *
 * Verifies the feature end-to-end through plugin contributions: the
 * context-menu item comes from the ai-rename plugin (enabled by default), the
 * picker renders suggestions from the (mocked) backend, choosing one renames
 * the file via the normal flow (the mock fs persists the rename, so the list
 * reflects the new name), and disabling the plugin removes the menu entry.
 */
import { test, expect, type Page } from "./fixtures";
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

/** Set the ai-rename plugin's Gemini API key through its settings section. */
async function setApiKey(page: Page, key: string) {
  const dialog = await openSettings(page);
  const section = dialog.locator('.settings-section:has(h3:has-text("AI / Rename Suggestions"))');
  const input = section.locator('.setting-row:has-text("Gemini API Key") input[type="password"]');
  await input.fill(key);
  await input.press("Tab"); // fire onchange (persist)
  await closeSettings(page);
}

async function setAiRenameEnabled(page: Page, enabled: boolean) {
  const dialog = await openSettings(page);
  const row = dialog.locator('.setting-row:has-text("AI Rename")').first();
  const toggle = row.locator('input[type="checkbox"]').first();
  await expect(toggle).toHaveCount(1);
  if ((await toggle.isChecked()) !== enabled) {
    await row.locator("label.toggle").click();
  }
  await expect(toggle).toBeChecked({ checked: enabled });
  await closeSettings(page);
}

async function rightClickNotes(page: Page) {
  const entry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
  await expect(entry).toBeVisible({ timeout: 3000 });
  await entry.click();
  await entry.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible", timeout: 2000 });
  return menu;
}

test.describe("AI Rename plugin", () => {
  test("context menu → picker → choosing a name renames the file", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await setApiKey(page, "test-key-123");

    const menu = await rightClickNotes(page);
    const item = menu.locator('.menu-item:has-text("Suggest rename")');
    await expect(item).toBeVisible();
    await item.click();

    // Dialog opens; suggestions (from the mock) render.
    const dialog = page.locator('[aria-labelledby="ai-rename-title"]');
    await expect(dialog).toBeVisible();
    const suggestions = dialog.locator('[data-testid="ai-rename-suggestions"] .suggestion');
    await expect(suggestions.first()).toBeVisible({ timeout: 3000 });
    await expect(suggestions).toHaveCount(3);
    await expect(suggestions.first()).toContainText("meeting-notes.md");

    // Choose the first suggestion → rename applies, dialog closes.
    await suggestions.first().click();
    await expect(dialog).toBeHidden();

    // Visible outcome: the list now shows the renamed file, old name gone.
    // Exact-match the name cell — "meeting-notes.md" contains "notes.md" as a
    // substring, so a loose filter would falsely still match the old name.
    await expect(page.locator(".name-text", { hasText: /^meeting-notes\.md$/ })).toBeVisible({
      timeout: 3000,
    });
    await expect(page.locator(".name-text", { hasText: /^notes\.md$/ })).toHaveCount(0);
  });

  test("picker warns when no API key is configured", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    const menu = await rightClickNotes(page);
    await menu.locator('.menu-item:has-text("Suggest rename")').click();

    const dialog = page.locator('[aria-labelledby="ai-rename-title"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".api-key-warning")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("disabling the plugin removes the context-menu entry", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await setAiRenameEnabled(page, false);

    const menu = await rightClickNotes(page);
    await expect(menu.locator('.menu-item:has-text("Suggest rename")')).toHaveCount(0);

    // Re-enable to leave state clean and confirm it comes back.
    await page.keyboard.press("Escape");
    await setAiRenameEnabled(page, true);
    const menu2 = await rightClickNotes(page);
    await expect(menu2.locator('.menu-item:has-text("Suggest rename")')).toBeVisible();
  });
});
