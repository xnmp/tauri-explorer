import { test, expect } from "@playwright/test";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";

for (const viewMode of VIEW_MODES) {
  test.describe(`File Operations [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
    });

    test.describe("Context Menu", () => {
      test("right-click on file shows context menu @smoke", async ({ page }) => {
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
      test("Ctrl+C marks file as copied with clipboard banner @smoke", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        await pressShortcut(page, "c", { ctrlKey: true });

        const banner = page.locator(".toast.clipboard");
        await expect(banner).toBeVisible({ timeout: 2000 });
        await expect(banner).toContainText("Copied");
      });

      test("Ctrl+X marks file as cut with faded appearance @smoke", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        await pressShortcut(page, "x", { ctrlKey: true });

        await expect(file).toHaveClass(/cut/);

        const banner = page.locator(".toast.clipboard");
        await expect(banner).toContainText("Cut");
      });

      test("clipboard toast auto-dismisses", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();
        await pressShortcut(page, "c", { ctrlKey: true });

        const toast = page.locator(".toast.clipboard");
        await expect(toast).toBeVisible();

        await expect(toast).not.toBeVisible({ timeout: 5000 });
      });

      test("Ctrl+C does not freeze the UI", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        await pressShortcut(page, "c", { ctrlKey: true });
        const banner = page.locator(".toast.clipboard");
        await expect(banner).toBeVisible({ timeout: 1000 });

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

        const secondFile = page.locator(".entry-item").nth(1);
        await secondFile.click({ timeout: 1000 });
        await expect(secondFile).toHaveClass(/selected/);
      });

      test("Ctrl+A then Ctrl+C copies multiple files", async ({ page }) => {
        const firstItem = page.locator(".entry-item").first();
        await firstItem.click();

        await page.keyboard.press("Control+a");

        const totalItems = await page.locator(".entry-item").count();
        await expect(page.locator(".entry-item.selected")).toHaveCount(totalItems);

        await pressShortcut(page, "c", { ctrlKey: true });
        const banner = page.locator(".toast.clipboard");
        await expect(banner).toBeVisible({ timeout: 2000 });
        await expect(banner).toContainText("Copied");
      });

      test("cut after copy replaces clipboard operation", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        await pressShortcut(page, "c", { ctrlKey: true });
        const banner = page.locator(".toast.clipboard");
        await expect(banner).toBeVisible();
        await expect(banner).toContainText("Copied");

        await pressShortcut(page, "x", { ctrlKey: true });
        await expect(banner).toContainText("Cut");
        await expect(file).toHaveClass(/cut/);
      });

      test("context menu Copy works on file @smoke", async ({ page }) => {
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
      test("F2 opens inline rename @smoke", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        await page.keyboard.press("F2");

        const renameInput = page.locator(".rename-input");
        await expect(renameInput).toBeVisible();
      });

      test("Escape cancels rename", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        const originalName = await file.locator(".entry-name").textContent();

        await file.click();
        await file.focus();
        await page.keyboard.press("F2");

        const renameInput = page.locator(".rename-input");
        await expect(renameInput).toBeVisible();

        await renameInput.fill("new-name");
        await page.keyboard.press("Escape");

        await expect(renameInput).not.toBeVisible({ timeout: 2000 });

        const updatedFile = page.locator(".entry-item").first();
        await expect(updatedFile.locator(".entry-name")).toBeVisible();
        const currentName = await updatedFile.locator(".entry-name").textContent();
        expect(currentName).toBe(originalName);
      });

      test("typing in rename input does not trigger type-ahead selection", async ({ page }) => {
        // Use a file entry (not directory) for rename
        const file = page.locator(".entry-item:not(.directory)").first();
        await file.click();
        const originalName = await file.locator(".entry-name").textContent();

        // Count how many entries are selected before rename
        const selectedBefore = await page.locator(".entry-item.selected").count();
        expect(selectedBefore).toBe(1);

        await page.keyboard.press("F2");
        const renameInput = page.locator(".rename-input");
        await expect(renameInput).toBeFocused();

        // Type "d" character-by-character — this would match "Documents" via
        // type-ahead if keystrokes leaked out of the rename input.
        await renameInput.fill("");
        await renameInput.pressSequentially("d");

        // The input should contain what we typed, not be cleared by a selection change
        await expect(renameInput).toHaveValue("d");

        // Only one entry should be selected — if type-ahead fired, "Documents"
        // would also get selected/focused, causing visible side effects.
        const selectedAfter = await page.locator(".entry-item.selected").count();
        expect(selectedAfter).toBe(1);

        // The original file should still be the one in rename mode
        await expect(file).toHaveClass(/renaming|selected/);

        // Cancel and verify original name preserved
        await page.keyboard.press("Escape");
        await expect(file.locator(".entry-name")).toHaveText(originalName!);
      });

      test("Enter confirms rename and updates the entry name @smoke", async ({ page }) => {
        const file = page.locator(".entry-item:not(.directory)").first();
        await file.click();

        await page.keyboard.press("F2");
        const renameInput = page.locator(".rename-input");
        await expect(renameInput).toBeFocused();

        await renameInput.fill("renamed-file.txt");
        await page.keyboard.press("Enter");

        // Rename input should close
        await expect(renameInput).not.toBeVisible({ timeout: 2000 });

        // The entry should now show the new name
        const renamedEntry = page.locator(".entry-item .entry-name", { hasText: "renamed-file.txt" });
        await expect(renamedEntry).toBeVisible({ timeout: 2000 });
      });
    });

    test.describe("Delete", () => {
      test("Delete key opens delete confirmation @smoke", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        await page.keyboard.press("Delete");

        const dialog = page.locator("[role='alertdialog']");
        await expect(dialog).toBeVisible();
      });

      test("Cancel closes delete dialog", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        await page.keyboard.press("Delete");

        const dialog = page.locator("[role='alertdialog']");
        await expect(dialog).toBeVisible();

        await page.getByRole("button", { name: /cancel/i }).click();
        await expect(dialog).not.toBeVisible();
      });
    });

    test.describe("Delete Recovery", () => {
      test("deleting a child folder from parent stays in parent without error", async ({ page }) => {
        const folder = page.locator(".entry-item.directory", { hasText: "Documents" });
        await folder.dblclick();

        const breadcrumbs = page.locator(".breadcrumbs-container");
        await expect(breadcrumbs).toContainText("Documents");

        // Re-apply view mode after navigating (navigation resets to default)
        if (viewMode !== "details") {
          await switchViewMode(page, viewMode);
        }

        const projectFolder = page.locator(".entry-item.directory", { hasText: "project" });
        await projectFolder.click();
        await page.keyboard.press("Delete");

        const dialog = page.locator("[role='alertdialog']");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: /^Delete/ }).click();

        await expect(breadcrumbs).toContainText("Documents");
        const errorState = page.locator(".error-state");
        await expect(errorState).not.toBeVisible();

        await expect(projectFolder).not.toBeVisible();
        const items = page.locator(".entry-item");
        await expect(items.first()).toBeVisible();
      });

      test("navigating forward to a deleted folder recovers gracefully", async ({ page }) => {
        const docsFolder = page.locator(".entry-item.directory", { hasText: "Documents" });
        await docsFolder.dblclick();

        const breadcrumbs = page.locator(".breadcrumbs-container");
        await expect(breadcrumbs).toContainText("Documents");

        const projectFolder = page.locator(".entry-item.directory", { hasText: "project" });
        await projectFolder.dblclick();
        await expect(breadcrumbs).toContainText("project");

        await page.locator('button[title*="Back"], button[aria-label*="Back"]').click();
        await expect(breadcrumbs).toContainText("Documents");

        // Re-apply view mode after navigating
        if (viewMode !== "details") {
          await switchViewMode(page, viewMode);
        }

        const projectEntry = page.locator(".entry-item.directory", { hasText: "project" });
        await projectEntry.click();
        await page.keyboard.press("Delete");

        const dialog = page.locator("[role='alertdialog']");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: /^Delete/ }).click();

        await expect(projectEntry).not.toBeVisible();

        await page.keyboard.press("Control+Alt+ArrowRight");

        const errorState = page.locator(".error-state");
        await expect(errorState).not.toBeVisible();

        const items = page.locator(".entry-item");
        await expect(items.first()).toBeVisible();
      });
    });

    test.describe("New Folder", () => {
      test("right-click on empty space shows New folder option @smoke", async ({ page }) => {
        await page.locator(".file-list .content").first().click({
          button: "right",
          position: { x: 10, y: 400 },
        });

        const contextMenu = page.locator(".context-menu");
        await expect(contextMenu.getByText("New folder")).toBeVisible();
      });
    });
  });
}

// Tiles-only: the rename box floats above neighboring tiles and grows to fit
// long names instead of scrolling inside a fixed two-line textarea.
test.describe("Tiles rename box", () => {
  test("grows to fit a long name without internal scrolling", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents&viewMode=tiles");
    await waitForEntries(page);

    await page.locator(".tile-item", { hasText: "presentation.pptx" }).click();
    await page.keyboard.press("F2");
    const box = page.locator(".tile-rename");
    await expect(box).toBeVisible();

    await box.fill(
      "this is a really long file name to test the comfortable rename box behavior.pptx",
    );

    // Wider than a tile (floats over neighbors) ...
    const width = await box.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThanOrEqual(180);

    // ... and tall enough that nothing needs scrolling.
    await expect
      .poll(() =>
        box.evaluate((el) => ({
          fits: el.clientHeight >= el.scrollHeight - 1,
          lines: el.clientHeight,
        })),
      )
      .toMatchObject({ fits: true });
    const height = await box.evaluate((el) => el.clientHeight);
    expect(height).toBeGreaterThan(40); // more than the old two-line box
  });
});
