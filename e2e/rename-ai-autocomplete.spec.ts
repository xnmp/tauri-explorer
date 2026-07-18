/**
 * E2E: AI rename autocomplete in the inline rename box (#215).
 *
 * With the ai-rename plugin's API key set, opening the rename box fetches a
 * suggestion (deterministic in mock mode: "meeting-notes.<ext>"); the hint
 * appears under the input, Tab fills it in, Enter applies it — the list must
 * show the renamed file. Without an API key the hint never appears and Tab
 * keeps its default behavior.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, waitForEntries, pressShortcut } from "./helpers";

async function setApiKey(page: Page, key: string) {
  await pressShortcut(page, ",", { ctrlKey: true });
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const section = dialog.locator('.settings-section:has(h3:has-text("AI / Rename Suggestions"))');
  const input = section.locator('.setting-row:has-text("Gemini API Key") input[type="password"]');
  await input.fill(key);
  await input.press("Tab"); // fire onchange (persist)
  await page.locator(".settings-dialog .close-btn").click();
  await expect(dialog).toBeHidden();
}

async function startRename(page: Page, filename: string) {
  const entry = page.locator(".entry-item").filter({ hasText: filename }).first();
  await expect(entry).toBeVisible({ timeout: 3000 });
  await entry.click();
  await page.keyboard.press("F2");
  await page.locator(".rename-input").waitFor({ state: "visible", timeout: 2000 });
}

test.describe("AI rename autocomplete", () => {
  test("Tab accepts the suggestion and Enter renames the file", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await setApiKey(page, "test-key");

    await startRename(page, "notes.md");

    // The mocked model suggests "meeting-notes.md" (first mock suggestion).
    const hint = page.locator(".rename-suggestion");
    await expect(hint).toBeVisible({ timeout: 3000 });
    await expect(hint).toContainText("meeting-notes.md");

    // Tab fills the input (and keeps focus in the box)...
    await page.keyboard.press("Tab");
    await expect(page.locator(".rename-input")).toHaveValue("meeting-notes.md");
    // ...and the hint hides once the input already holds the suggestion.
    await expect(hint).toHaveCount(0);

    // Enter applies the rename — the real outcome: the list shows the new name.
    await page.keyboard.press("Enter");
    await expect(page.locator(".rename-input")).toHaveCount(0);
    await expect(
      page.locator(".entry-item").filter({ hasText: "meeting-notes.md" }),
    ).toHaveCount(1, { timeout: 3000 });
    await expect(page.locator(".entry-item").filter({ hasText: /^notes\.md/ })).toHaveCount(0);
  });

  test("clicking the hint accepts the suggestion without committing", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await setApiKey(page, "test-key");

    await startRename(page, "readme.txt");

    const hint = page.locator(".rename-suggestion");
    await expect(hint).toBeVisible({ timeout: 3000 });
    await hint.click();

    // The box is still open, now holding the suggestion.
    await expect(page.locator(".rename-input")).toHaveValue("meeting-notes.txt");

    // Escape cancels — no rename happened.
    await page.keyboard.press("Escape");
    await expect(page.locator(".rename-input")).toHaveCount(0);
    await expect(page.locator(".entry-item").filter({ hasText: "readme.txt" })).toHaveCount(1);
  });

  test("no API key: no hint, rename still works normally", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await startRename(page, "notes.md");

    // Give a would-be fetch time to land; the hint must never appear.
    await page.waitForTimeout(500);
    await expect(page.locator(".rename-suggestion")).toHaveCount(0);

    // Plain rename still functions.
    await page.locator(".rename-input").fill("plain-rename.md");
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".entry-item").filter({ hasText: "plain-rename.md" }),
    ).toHaveCount(1, { timeout: 3000 });
  });
});
