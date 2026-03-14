/**
 * E2E tests for tilde (~) expansion in address bar and QuickOpen.
 * Issue: tauri-explorer-uh8c
 */

import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

test.describe("Tilde Expansion", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
  });

  test("address bar expands ~ to home directory", async ({ page }) => {
    // Click breadcrumbs to start path editing
    const breadcrumbs = page.locator(".breadcrumbs-container");
    await breadcrumbs.click();
    await page.waitForTimeout(200);

    const pathInput = page.locator(".path-input");
    await expect(pathInput).toBeVisible();

    // Clear and type ~ path
    await pathInput.fill("~/Documents");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    // Should navigate to /home/user/Documents
    const newBreadcrumbs = page.locator(".breadcrumbs-container");
    await expect(newBreadcrumbs).toContainText("Documents");
  });

  test("address bar autocomplete works with ~ prefix", async ({ page }) => {
    const breadcrumbs = page.locator(".breadcrumbs-container");
    await breadcrumbs.click();
    await page.waitForTimeout(200);

    const pathInput = page.locator(".path-input");
    await pathInput.fill("~/");
    await page.waitForTimeout(500);

    // Autocomplete suggestions should appear for home directory contents
    const suggestions = page.locator(".suggestion-item");
    const count = await suggestions.count();
    expect(count).toBeGreaterThan(0);
  });

  test("QuickOpen navigates to ~/Documents on Enter", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(300);

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await searchInput.fill("~/Documents");
    await page.waitForTimeout(200);

    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    // Quick open should close
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).not.toBeVisible();

    // Should navigate to Documents
    const breadcrumbs = page.locator(".breadcrumbs-container");
    await expect(breadcrumbs).toContainText("Documents");
  });

  test("QuickOpen navigates to / path on Enter", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(300);

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await searchInput.fill("/home");
    await page.waitForTimeout(200);

    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).not.toBeVisible();

    const breadcrumbs = page.locator(".breadcrumbs-container");
    await expect(breadcrumbs).toContainText("home");
  });
});
