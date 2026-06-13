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

    const pathInput = page.locator(".path-input");
    await expect(pathInput).toBeVisible();

    // Clear and type ~ path
    await pathInput.fill("~/Documents");
    await page.keyboard.press("Enter");

    // Should navigate to /home/user/Documents
    const newBreadcrumbs = page.locator(".breadcrumbs-container");
    await expect(newBreadcrumbs).toContainText("Documents");
  });

  test("address bar autocomplete works with ~ prefix", async ({ page }) => {
    const breadcrumbs = page.locator(".breadcrumbs-container");
    await breadcrumbs.click();

    const pathInput = page.locator(".path-input");
    await expect(pathInput).toBeVisible();
    await pathInput.fill("~/");

    // Autocomplete suggestions should appear for home directory contents
    await expect
      .poll(() => page.locator(".suggestion-item").count())
      .toBeGreaterThan(0);
  });

  test("QuickOpen navigates to ~/Documents on Enter", async ({ page }) => {
    await page.keyboard.press("Control+p");

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("~/Documents");
    await expect(searchInput).toHaveValue("~/Documents");

    await page.keyboard.press("Enter");

    // Quick open should close
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).not.toBeVisible();

    // Should navigate to Documents
    const breadcrumbs = page.locator(".breadcrumbs-container");
    await expect(breadcrumbs).toContainText("Documents");
  });

  test("QuickOpen navigates to / path on Enter", async ({ page }) => {
    await page.keyboard.press("Control+p");

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("/home");
    await expect(searchInput).toHaveValue("/home");

    await page.keyboard.press("Enter");

    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).not.toBeVisible();

    const breadcrumbs = page.locator(".breadcrumbs-container");
    await expect(breadcrumbs).toContainText("home");
  });
});
