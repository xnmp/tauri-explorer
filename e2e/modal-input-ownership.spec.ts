import { test, expect, type Page } from "./fixtures";
import type { Locator } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

async function selectedName(page: Page): Promise<string> {
  return (await page.locator(".entry-item.selected .entry-name").first().textContent())?.trim() ?? "";
}

async function assertInputBlockedThenResumes(page: Page, modal: Locator, screenshotPath?: string) {
  const selectedBefore = await selectedName(page);
  const tabsBefore = await page.locator('[role="tab"]').count();
  const activePane = page.locator(".explorer-pane").first();

  await activePane.dispatchEvent("keydown", { key: "ArrowUp", code: "ArrowUp" });
  await page.keyboard.press("Control+t");
  expect(await selectedName(page)).toBe(selectedBefore);
  await expect(page.locator('[role="tab"]')).toHaveCount(tabsBefore);
  if (screenshotPath) await page.screenshot({ path: screenshotPath });

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  // The registry close removes the dialog synchronously; allow Svelte's
  // ownership-effect cleanup to flush before exercising the underlying pane.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.keyboard.press("Control+t");
  await expect(page.locator('[role="tab"]')).toHaveCount(tabsBefore + 1);
  await page.keyboard.press("Control+w");
  await expect(page.locator('[role="tab"]')).toHaveCount(tabsBefore);
  await activePane.dispatchEvent("keydown", { key: "ArrowUp", code: "ArrowUp" });
  expect(await selectedName(page)).not.toBe(selectedBefore);
}

test.describe("modal input ownership", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await page.locator(".entry-item", { hasText: "readme.txt" }).first().click();
  });

  test("a contributed plugin dialog blocks file navigation and app shortcuts until close", async ({ page }) => {
    await page.keyboard.press("Control+Shift+p");
    const palette = page.locator(".command-palette-dialog");
    await expect(palette).toBeVisible();
    await palette.locator(".search-input").fill("AI: Suggest Rename");
    await palette.locator('.command-item:has-text("AI: Suggest Rename")').click();

    const pluginDialog = page.getByRole("dialog", { name: "Suggest rename" });
    await expect(pluginDialog).toBeVisible({ timeout: 3000 });
    await assertInputBlockedThenResumes(
      page,
      pluginDialog,
      "screenshots/refactor/repo-health-cleanup/modal-input-ownership.png",
    );
  });

  test("shortcut help blocks file navigation and app shortcuts until close", async ({ page }) => {
    await page.keyboard.press("Control+/");
    const shortcutHelp = page.locator('[data-testid="shortcut-cheatsheet"]');
    await expect(shortcutHelp).toBeVisible();
    await assertInputBlockedThenResumes(page, shortcutHelp);
  });
});
