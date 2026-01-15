import { test, expect } from "@playwright/test";

test.describe("File Operations", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".file-list");
    await page.locator(".file-item").first().waitFor({ timeout: 5000 });
  });

  test.describe("Context Menu", () => {
    test("right-click on file shows context menu", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();
    });

    test("context menu has Cut, Copy, Rename, Delete options", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu.getByText("Cut")).toBeVisible();
      await expect(contextMenu.getByText("Copy")).toBeVisible();
      await expect(contextMenu.getByText("Rename")).toBeVisible();
      await expect(contextMenu.getByText("Delete")).toBeVisible();
    });

    test("clicking outside context menu closes it", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();

      // Click elsewhere
      await page.locator(".file-list").click({ position: { x: 10, y: 10 } });
      await expect(contextMenu).not.toBeVisible();
    });

    test("pressing Escape closes context menu", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(contextMenu).not.toBeVisible();
    });
  });

  test.describe("Cut/Copy/Paste", () => {
    test("Ctrl+C marks file as copied with clipboard banner", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();

      await page.keyboard.press("Control+c");

      // Clipboard banner should appear
      const banner = page.locator(".clipboard-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Copied");
    });

    test("Ctrl+X marks file as cut with faded appearance", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();

      await page.keyboard.press("Control+x");

      // File should have cut styling
      await expect(file).toHaveClass(/cut/);

      // Clipboard banner should show "Cut"
      const banner = page.locator(".clipboard-banner");
      await expect(banner).toContainText("Cut");
    });

    test("clear clipboard button works", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();
      await page.keyboard.press("Control+c");

      const banner = page.locator(".clipboard-banner");
      await expect(banner).toBeVisible();

      // Click clear button
      await page.locator(".clipboard-clear").click();
      await expect(banner).not.toBeVisible();
    });
  });

  test.describe("Rename", () => {
    test("F2 opens inline rename", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();

      await page.keyboard.press("F2");

      // Should show rename input
      const renameInput = page.locator(".rename-input, input[type='text']").first();
      await expect(renameInput).toBeVisible();
    });

    test("Escape cancels rename", async ({ page }) => {
      const file = page.locator(".file-item").first();
      const originalName = await file.locator(".file-name").textContent();

      await file.click();
      await page.keyboard.press("F2");

      // Type something
      await page.keyboard.type("new-name");
      await page.keyboard.press("Escape");

      // Name should be unchanged
      const currentName = await file.locator(".file-name").textContent();
      expect(currentName).toBe(originalName);
    });
  });

  test.describe("Delete", () => {
    test("Delete key opens delete confirmation", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();

      await page.keyboard.press("Delete");

      // Delete dialog should appear
      const dialog = page.locator(".delete-dialog, [role='dialog']");
      await expect(dialog).toBeVisible();
    });

    test("Cancel closes delete dialog", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();

      await page.keyboard.press("Delete");

      const dialog = page.locator(".delete-dialog, [role='dialog']");
      await expect(dialog).toBeVisible();

      // Click cancel
      await page.getByRole("button", { name: /cancel/i }).click();
      await expect(dialog).not.toBeVisible();
    });
  });

  test.describe("New Folder", () => {
    test("right-click on empty space shows New folder option", async ({ page }) => {
      // Click empty space
      await page.locator(".file-list .content, .details-view").click({
        button: "right",
        position: { x: 10, y: 400 },
      });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu.getByText("New folder")).toBeVisible();
    });
  });
});
