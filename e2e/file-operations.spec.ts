import { test, expect } from "@playwright/test";

/**
 * Dispatch a keyboard shortcut via JS dispatchEvent.
 * Playwright's keyboard.press("Control+c") triggers Chromium's native clipboard
 * which hangs in headless mode. Using dispatchEvent bypasses the native clipboard
 * while still exercising the app's keydown handler.
 */
async function pressShortcut(
  page: import("@playwright/test").Page,
  key: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
) {
  await page.evaluate(
    ({ key, ctrlKey, shiftKey, altKey }) => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: `Key${key.toUpperCase()}`,
          ctrlKey: ctrlKey ?? false,
          shiftKey: shiftKey ?? false,
          altKey: altKey ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { key, ...modifiers },
  );
}

test.describe("File Operations", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.waitForSelector(".file-list");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  });

  test.describe("Context Menu", () => {
    test("right-click on file shows context menu", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();
    });

    test("context menu has Cut, Copy, Rename, Delete options", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu.getByText("Cut")).toBeVisible();
      await expect(contextMenu.getByText("Copy")).toBeVisible();
      await expect(contextMenu.getByText("Rename")).toBeVisible();
      await expect(contextMenu.getByText("Delete")).toBeVisible();
    });

    test("clicking outside context menu closes it", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();

      // Click on the backdrop which closes the menu
      await page.locator(".context-menu-backdrop").click();
      await expect(contextMenu).not.toBeVisible();
    });

    test("pressing Escape closes context menu", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(contextMenu).not.toBeVisible();
    });
  });

  test.describe("Cut/Copy/Paste", () => {
    test("Ctrl+C marks file as copied with clipboard banner", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "c", { ctrlKey: true });

      const banner = page.locator(".toast.clipboard");
      await expect(banner).toBeVisible({ timeout: 2000 });
      await expect(banner).toContainText("Copied");
    });

    test("Ctrl+X marks file as cut with faded appearance", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "x", { ctrlKey: true });

      // File should have cut styling
      await expect(file).toHaveClass(/cut/);

      // Clipboard banner should show "Cut"
      const banner = page.locator(".toast.clipboard");
      await expect(banner).toContainText("Cut");
    });

    test("clipboard toast auto-dismisses", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();
      await pressShortcut(page, "c", { ctrlKey: true });

      const toast = page.locator(".toast.clipboard");
      await expect(toast).toBeVisible();

      // Toast should auto-dismiss after 3 seconds
      await expect(toast).not.toBeVisible({ timeout: 5000 });
    });

    test("Ctrl+C does not freeze the UI", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "c", { ctrlKey: true });
      const banner = page.locator(".toast.clipboard");
      await expect(banner).toBeVisible({ timeout: 1000 });

      // UI should remain responsive: clicking another file should work
      const secondFile = page.locator(".entry-item").nth(1);
      await secondFile.click({ timeout: 1000 });
      await expect(secondFile).toHaveClass(/selected/);
    });

    test("Ctrl+X does not freeze the UI", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "x", { ctrlKey: true });
      const banner = page.locator(".toast.clipboard");
      await expect(banner).toBeVisible({ timeout: 1000 });

      // UI should remain responsive
      const secondFile = page.locator(".entry-item").nth(1);
      await secondFile.click({ timeout: 1000 });
      await expect(secondFile).toHaveClass(/selected/);
    });

    test("Ctrl+A then Ctrl+C copies multiple files", async ({ page }) => {
      const firstItem = page.locator(".entry-item").first();
      await firstItem.click();

      // Select all
      await page.keyboard.press("Control+a");
      await page.waitForTimeout(50);

      const totalItems = await page.locator(".entry-item").count();
      const selectedItems = await page.locator(".entry-item.selected").count();
      expect(selectedItems).toBe(totalItems);

      // Copy all
      await pressShortcut(page, "c", { ctrlKey: true });
      const banner = page.locator(".toast.clipboard");
      await expect(banner).toBeVisible({ timeout: 2000 });
      await expect(banner).toContainText("Copied");
    });

    test("cut after copy replaces clipboard operation", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      // First copy
      await pressShortcut(page, "c", { ctrlKey: true });
      const banner = page.locator(".toast.clipboard");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Copied");

      // Then cut — should replace copy
      await pressShortcut(page, "x", { ctrlKey: true });
      await expect(banner).toContainText("Cut");
      await expect(file).toHaveClass(/cut/);
    });

    test("context menu Copy works on file", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();

      await contextMenu.getByText("Copy").click();

      const banner = page.locator(".toast.clipboard");
      await expect(banner).toBeVisible({ timeout: 2000 });
      await expect(banner).toContainText("Copied");
    });

    test("context menu Cut works on file", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();
      await file.click({ button: "right" });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();

      await contextMenu.getByText("Cut").click();

      const banner = page.locator(".toast.clipboard");
      await expect(banner).toBeVisible({ timeout: 2000 });
      await expect(banner).toContainText("Cut");
      await expect(file).toHaveClass(/cut/);
    });
  });

  test.describe("Rename", () => {
    test("F2 opens inline rename", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await page.keyboard.press("F2");

      // Should show rename input
      const renameInput = page.locator(".rename-input");
      await expect(renameInput).toBeVisible();
    });

    test("Escape cancels rename", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      const originalName = await file.locator(".entry-name").textContent();

      // Focus the file item and press F2
      await file.click();
      await file.focus();
      await page.keyboard.press("F2");

      // Wait for rename input to appear
      const renameInput = page.locator(".rename-input");
      await expect(renameInput).toBeVisible();

      // Type something then cancel
      await renameInput.fill("new-name");
      await page.keyboard.press("Escape");

      // Wait for rename input to disappear and name span to reappear
      await expect(renameInput).not.toBeVisible({ timeout: 2000 });

      // Name should be unchanged - need to re-query for the updated element
      const updatedFile = page.locator(".entry-item").first();
      await expect(updatedFile.locator(".entry-name")).toBeVisible();
      const currentName = await updatedFile.locator(".entry-name").textContent();
      expect(currentName).toBe(originalName);
    });
  });

  test.describe("Delete", () => {
    test("Delete key opens delete confirmation", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await page.keyboard.press("Delete");

      // Delete dialog should appear (uses role="alertdialog")
      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
    });

    test("Cancel closes delete dialog", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await page.keyboard.press("Delete");

      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();

      // Click cancel
      await page.getByRole("button", { name: /cancel/i }).click();
      await expect(dialog).not.toBeVisible();
    });
  });

  test.describe("Delete Recovery", () => {
    test("deleting a child folder from parent stays in parent without error", async ({ page }) => {
      // Navigate into Documents
      const folder = page.locator(".entry-item.directory", { hasText: "Documents" });
      await folder.dblclick();
      await page.waitForTimeout(500);

      const breadcrumbs = page.locator(".breadcrumbs-container");
      await expect(breadcrumbs).toContainText("Documents");

      // Select the project folder and delete it
      const projectFolder = page.locator(".entry-item.directory", { hasText: "project" });
      await projectFolder.click();
      await page.keyboard.press("Delete");

      // Confirm deletion
      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /^Delete/ }).click();
      await page.waitForTimeout(500);

      // Should remain in Documents with no error — no refresh needed
      await expect(breadcrumbs).toContainText("Documents");
      const errorState = page.locator(".error-state");
      await expect(errorState).not.toBeVisible();

      // project folder should be gone, other items remain
      await expect(projectFolder).not.toBeVisible();
      const items = page.locator(".entry-item");
      await expect(items.first()).toBeVisible();
    });

    test("navigating forward to a deleted folder recovers gracefully", async ({ page }) => {
      // Navigate: home/user → Documents → project
      const docsFolder = page.locator(".entry-item.directory", { hasText: "Documents" });
      await docsFolder.dblclick();
      await page.waitForTimeout(500);

      const breadcrumbs = page.locator(".breadcrumbs-container");
      await expect(breadcrumbs).toContainText("Documents");

      const projectFolder = page.locator(".entry-item.directory", { hasText: "project" });
      await projectFolder.dblclick();
      await page.waitForTimeout(500);
      await expect(breadcrumbs).toContainText("project");

      // Go back to Documents
      await page.locator('button[title*="Back"], button[aria-label*="Back"]').click();
      await page.waitForTimeout(500);
      await expect(breadcrumbs).toContainText("Documents");

      // Delete the project folder from Documents listing
      const projectEntry = page.locator(".entry-item.directory", { hasText: "project" });
      await projectEntry.click();
      await page.keyboard.press("Delete");

      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /^Delete/ }).click();
      await page.waitForTimeout(500);

      // project should be removed from listing
      await expect(projectEntry).not.toBeVisible();

      // Navigate forward — history points to the now-deleted project path
      await page.keyboard.press("Control+Alt+ArrowRight");
      await page.waitForTimeout(500);

      // Should NOT show an error state
      const errorState = page.locator(".error-state");
      await expect(errorState).not.toBeVisible();

      // Should still show file items (either stayed at Documents or recovered to parent)
      const items = page.locator(".entry-item");
      await expect(items.first()).toBeVisible();
    });
  });

  test.describe("New Folder", () => {
    test("right-click on empty space shows New folder option", async ({ page }) => {
      // Click empty space in content area
      await page.locator(".file-list .content").first().click({
        button: "right",
        position: { x: 10, y: 400 },
      });

      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu.getByText("New folder")).toBeVisible();
    });
  });
});
