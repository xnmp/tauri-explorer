/**
 * Theme picker commit/revert behavior (#251, #164).
 *
 * Committing a theme must apply it visually on the FIRST attempt — the
 * regression was an $effect-teardown revert that put the old data-theme
 * back right after commit (settings said "aurora", the DOM stayed on the
 * previous theme, and the integrated terminal — keyed on settings — flipped
 * alone).
 */
import { test, expect } from "./fixtures";
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

  test("committing a theme applies it visually on the first attempt @smoke", async ({ page }) => {
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

  test("Page Up and Down move five rows, clamp at the ends and reveal the selection", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 650 });
    await openThemePicker(page);
    const selected = page.locator('.theme-picker-dialog [role="option"][aria-selected="true"]');
    await page.keyboard.press("PageUp");
    await expect(selected).toHaveAttribute("id", "theme-option-0");
    await page.keyboard.press("PageDown");
    await expect(selected).toHaveAttribute("id", "theme-option-5");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hacker");
    await expect(selected).toBeInViewport({ ratio: 1 });
    if (process.env.CAPTURE_EVIDENCE) {
      await page.screenshot({ path: "screenshots/feat/theme-picker-page-keys/page-down-to-hacker.png" });
    }
    await page.keyboard.press("PageDown");
    await expect(selected).toHaveAttribute("id", "theme-option-10");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
    await expect(selected).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("PageDown");
    await expect(selected).toHaveAttribute("id", "theme-option-11");
    await page.keyboard.press("PageUp");
    await expect(selected).toHaveAttribute("id", "theme-option-6");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "desert");
    await expect(selected).toBeInViewport({ ratio: 1 });
    if (process.env.CAPTURE_EVIDENCE) {
      await page.screenshot({ path: "screenshots/feat/theme-picker-page-keys/page-up-to-desert.png" });
    }
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(selected).toHaveAttribute("id", "theme-option-8");
    // Only three rows remain: a page still lands on the last available row.
    await page.keyboard.press("PageDown");
    await expect(selected).toHaveAttribute("id", "theme-option-11");
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await expect(selected).toHaveAttribute("id", "theme-option-0");
    await page.keyboard.press("PageDown");
    await page.keyboard.press("Enter");
    await expect(page.locator(".theme-picker-dialog")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hacker");
  });

  test("paging uses filtered rows and leaves an empty result usable", async ({ page }) => {
    await openThemePicker(page);
    const input = page.locator(".theme-picker-dialog .search-input");
    const selected = page.locator('.theme-picker-dialog [role="option"][aria-selected="true"]');
    await input.fill("light");
    await expect(page.locator('.theme-picker-dialog [role="option"]')).toHaveCount(2);
    await page.keyboard.press("PageDown");
    await expect(selected).toHaveAttribute("id", "theme-option-1");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "solarized-light");
    await page.keyboard.press("PageUp");
    await expect(selected).toHaveAttribute("id", "theme-option-0");
    await input.fill("no-matching-theme");
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageUp");
    await expect(page.locator(".theme-picker-dialog .no-results")).toBeVisible();
    await expect(selected).toHaveCount(0);
    await input.fill("");
    await page.keyboard.press("PageDown");
    await expect(selected).toHaveAttribute("id", "theme-option-5");
    await page.keyboard.press("Escape");
    await expect(page.locator(".theme-picker-dialog")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
