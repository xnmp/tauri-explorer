/**
 * Theme picker commit/revert behavior (#251, #164).
 *
 * Committing a theme must apply it visually on the FIRST attempt — the
 * regression was an $effect-teardown revert that put the old data-theme
 * back right after commit (settings said "aurora", the DOM stayed on the
 * previous theme, and the integrated terminal — keyed on settings — flipped
 * alone).
 */
import { test, expect } from "@playwright/test";
import { waitForEntries, HOME_URL } from "./helpers";

async function openThemePicker(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Switch Theme");
  await page.keyboard.press("Enter");
  await expect(page.locator(".theme-picker-dialog")).toBeVisible();
}

test.describe("Theme picker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME_URL);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);
  });

  test("committing a theme applies it visually on the first attempt", async ({ page }) => {
    await openThemePicker(page);

    await page.locator(".theme-picker-dialog .search-input").fill("aurora");
    await page.keyboard.press("Enter");

    await expect(page.locator(".theme-picker-dialog")).toBeHidden();
    // The DOM theme, the persisted setting, and the picker's notion of
    // "current" must all agree after ONE commit.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
    const persisted = await page.evaluate(
      () => JSON.parse(localStorage.getItem("explorer-settings") ?? "{}").theme
    );
    expect(persisted).toBe("aurora");

    // Committing a second, different theme also lands first try (the
    // regression only surfaced from the second commit onwards).
    await openThemePicker(page);
    await page.locator(".theme-picker-dialog .search-input").fill("ocean");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-blue");
  });

  test("escape reverts an arrowed live preview to the saved theme", async ({ page }) => {
    const before = await page.locator("html").getAttribute("data-theme");

    await openThemePicker(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");

    await expect(page.locator(".theme-picker-dialog")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-theme", before ?? "light");
  });
});
