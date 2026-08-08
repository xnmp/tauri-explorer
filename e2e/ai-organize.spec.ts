/**
 * E2E: AI destination suggestions plugin (#158).
 *
 * Verifies the feature end-to-end through plugin contributions: the
 * context-menu item comes from the ai-organize plugin (enabled by default),
 * the picker renders ranked destinations from the (mocked) backend, and
 * choosing one MOVES the file via the normal transfer flow — the mock fs
 * persists the move, so the source listing loses the file.
 */
import { test, expect, type Page } from "./fixtures";
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

async function chooseAiMenuItem(page: Page, label: string) {
  const aiGroup = page.locator(".context-menu > .submenu-wrapper").filter({ hasText: "AI" });
  await aiGroup.hover();
  await aiGroup.locator(`.submenu .menu-item:has-text("${label}")`).click();
}

test.describe("AI destination suggestions", () => {
  test("groups file AI actions in an AI submenu", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    const entry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
    await entry.click();
    await entry.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await menu.waitFor({ state: "visible", timeout: 3000 });

    for (const action of ["Suggest destination", "Suggest rename"]) {
      await expect(menu.locator(`:scope > .menu-item:has-text("${action}")`)).toHaveCount(0);
    }

    const aiGroup = menu.locator(":scope > .submenu-wrapper").filter({ hasText: "AI" });
    await expect(aiGroup.getByRole("menuitem", { name: "AI", exact: true })).toBeVisible();
    await page.screenshot({ path: "evidence/ac-1-ai-submenu-entry.png" });
    await aiGroup.hover();

    const aiActions = aiGroup.locator(".submenu .menu-item");
    await expect(aiActions.filter({ hasText: "Suggest destination" })).toBeVisible();
    await expect(aiActions.filter({ hasText: "Suggest rename" })).toBeVisible();
    await page.screenshot({ path: "evidence/ac-2-ai-actions.png" });
    await aiActions.filter({ hasText: "Suggest destination" }).click();
    await expect(page.locator('[aria-labelledby="ai-organize-title"]')).toBeVisible();
    await page.screenshot({ path: "evidence/ac-3-suggest-destination-dialog.png" });
  });

  test("suggests candidate folders and moves the file on accept", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await setApiKey(page, "test-key-123");

    // Right-click notes.md → the plugin's context item.
    const entry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
    await entry.click();
    await entry.click({ button: "right" });
    await page.locator(".context-menu").waitFor({ state: "visible", timeout: 3000 });
    await chooseAiMenuItem(page, "Suggest destination");

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
    await chooseAiMenuItem(page, "Suggest destination");

    const dialog = page.locator('[aria-labelledby="ai-organize-title"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("API key not configured");
    await expect(dialog.locator(".link-btn")).toContainText("Open Settings");
  });
});
