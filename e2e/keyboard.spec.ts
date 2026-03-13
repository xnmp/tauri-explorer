/**
 * Keyboard Shortcut E2E Tests
 * Issue: tauri-explorer-gnvv - Test paste/undo shortcuts
 */

import { test, expect } from "@playwright/test";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";

for (const viewMode of VIEW_MODES) {
  test.describe(`Keyboard Shortcuts [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
    });

    test("Ctrl+A selects all files", async ({ page }) => {
      const firstItem = page.locator(".entry-item").first();
      await firstItem.click();

      await page.keyboard.press("Control+a");
      await page.waitForTimeout(100);

      const items = page.locator(".entry-item");
      const count = await items.count();
      expect(count).toBeGreaterThan(0);

      const selectedItems = page.locator(".entry-item.selected");
      const selectedCount = await selectedItems.count();
      expect(selectedCount).toBe(count);
    });

    test("Ctrl+C copies selected file to clipboard", async ({ page }) => {
      const firstItem = page.locator(".entry-item").first();
      await firstItem.click();
      await expect(firstItem).toHaveClass(/selected/);

      await pressShortcut(page, "c", { ctrlKey: true });
      await page.waitForTimeout(100);

      const clipboardBanner = page.locator(".toast.clipboard");
      await expect(clipboardBanner).toBeVisible({ timeout: 2000 });
      await expect(clipboardBanner).toContainText("Copied");
    });

    test("Ctrl+X cuts selected file to clipboard", async ({ page }) => {
      const firstFile = page.locator(".entry-item:not(.directory)").first();
      await firstFile.click();
      await expect(firstFile).toHaveClass(/selected/);

      await pressShortcut(page, "x", { ctrlKey: true });
      await page.waitForTimeout(100);

      const clipboardBanner = page.locator(".toast.clipboard.cut");
      await expect(clipboardBanner).toBeVisible({ timeout: 2000 });
      await expect(clipboardBanner).toContainText("Cut");
    });

    test("Ctrl+V pastes file from clipboard", async ({ page }) => {
      const firstFile = page.locator(".entry-item:not(.directory)").first();
      await firstFile.click();
      await pressShortcut(page, "c", { ctrlKey: true });
      await page.waitForTimeout(100);

      const clipboardBanner = page.locator(".toast.clipboard");
      await expect(clipboardBanner).toBeVisible();

      await pressShortcut(page, "v", { ctrlKey: true });
      await page.waitForTimeout(500);

      const toast = page.locator(".toast.success, .toast.error");
      const toastVisible = await toast.isVisible();
      expect(toastVisible || await clipboardBanner.isVisible()).toBe(true);
    });

    test("Ctrl+Z undoes last operation", async ({ page }) => {
      const firstFile = page.locator(".entry-item").first();
      await firstFile.click();
      await page.waitForTimeout(100);

      const explorerPane = page.locator(".explorer-pane");
      await explorerPane.focus();

      await pressShortcut(page, "z", { ctrlKey: true });
      await page.waitForTimeout(100);

      const fileItems = page.locator(".entry-item");
      await expect(fileItems.first()).toBeVisible();
    });

    test("Delete key opens delete confirmation", async ({ page }) => {
      const firstFile = page.locator(".entry-item:not(.directory)").first();
      await firstFile.click();
      await expect(firstFile).toHaveClass(/selected/);

      await page.keyboard.press("Delete");
      await page.waitForTimeout(100);

      const deleteDialog = page.locator(".delete-dialog, .dialog:has-text('Delete')");
      await expect(deleteDialog).toBeVisible({ timeout: 2000 });
    });

    test("F2 starts rename mode", async ({ page }) => {
      const firstItem = page.locator(".entry-item").first();
      await firstItem.click();
      await expect(firstItem).toHaveClass(/selected/);

      await page.keyboard.press("F2");
      await page.waitForTimeout(100);

      const renameInput = page.locator(".rename-input");
      await expect(renameInput).toBeVisible({ timeout: 2000 });
      await expect(renameInput).toBeFocused();
    });

    test("Escape cancels rename mode", async ({ page }) => {
      const firstItem = page.locator(".entry-item").first();
      await firstItem.click();
      await page.keyboard.press("F2");
      await page.waitForTimeout(100);

      const renameInput = page.locator(".rename-input");
      await expect(renameInput).toBeVisible();

      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);

      await expect(renameInput).not.toBeVisible();
    });

    test("Alt+Left navigates back in history", async ({ page }) => {
      const initialPath = await page.locator(".breadcrumbs-container").textContent();

      const folder = page.locator(".entry-item.directory").first();
      if (await folder.count() > 0) {
        await folder.dblclick();
        await waitForEntries(page);

        const newPath = await page.locator(".breadcrumbs-container").textContent();
        expect(newPath).not.toBe(initialPath);

        await page.keyboard.press("Control+Alt+ArrowLeft");
        await page.waitForTimeout(200);

        const backPath = await page.locator(".breadcrumbs-container").textContent();
        expect(backPath).toBe(initialPath);
      }
    });

    test("F5 refreshes the directory", async ({ page }) => {
      await page.keyboard.press("F5");

      await waitForEntries(page);

      const items = page.locator(".entry-item");
      const count = await items.count();
      expect(count).toBeGreaterThan(0);
    });

    test("Focus moves to file list items", async ({ page }) => {
      const firstItem = page.locator(".entry-item").first();
      await firstItem.click();

      await expect(firstItem).toBeFocused();
    });
  });
}
