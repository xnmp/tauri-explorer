/**
 * Regression tests for Ctrl+P Quick Open.
 * Issue: tauri-explorer-m2x3
 */

import { test, expect } from "@playwright/test";

test.describe("Quick Open (Ctrl+P)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.waitForSelector(".file-list");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  });

  test("Ctrl+P opens quick open dialog", async ({ page }) => {
    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });
  });

  test("search input is focused when opened", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(300);

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await expect(searchInput).toBeFocused();
  });

  test("typing in search input updates the value", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(300);

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await searchInput.pressSequentially("readme", { delay: 50 });
    await page.waitForTimeout(200);

    const value = await searchInput.inputValue();
    expect(value).toBe("readme");
  });

  test("typing does not clear input (regression)", async ({ page }) => {
    // This is the key regression test: typing should persist in the input
    // Previously, $effect re-running pruneNonExistent would reset query=""
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(300);

    const searchInput = page.locator(".quick-open-dialog .search-input");

    // Type character by character with delays to allow async effects
    await searchInput.pressSequentially("test", { delay: 100 });
    await page.waitForTimeout(500);

    const value = await searchInput.inputValue();
    expect(value).toBe("test");
  });

  test("Escape closes quick open", async ({ page }) => {
    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(quickOpen).not.toBeVisible();
  });

  test("re-opening quick open clears previous query", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(300);
    const searchInput = page.locator(".quick-open-dialog .search-input");
    await searchInput.pressSequentially("test", { delay: 50 });
    await page.waitForTimeout(200);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await page.keyboard.press("Control+p");
    await page.waitForTimeout(300);

    const value = await searchInput.inputValue();
    expect(value).toBe("");
  });
});
