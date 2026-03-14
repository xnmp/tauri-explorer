/**
 * E2E tests for recently implemented features:
 * - Ctrl+F filter bar (tauri-explorer-ryv1)
 * - Shift+Delete permanent delete dialog
 * - Space toggles preview pane
 * - Syntax highlighting in preview pane
 * - Paste to same folder (copy creates duplicate)
 */

import { test, expect } from "@playwright/test";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";

for (const viewMode of VIEW_MODES) {
  // ==========================================================
  // 1. Ctrl+F Filter Bar
  // ==========================================================
  test.describe(`Filter Bar [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
    });

    test("Ctrl+F opens filter bar", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      const filterBar = page.locator(".filter-bar");
      await expect(filterBar).toBeVisible({ timeout: 2000 });
    });

    test("filter bar input is focused when opened", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      await page.waitForTimeout(200);
      const filterInput = page.locator(".filter-input");
      await expect(filterInput).toBeFocused();
    });

    test("typing in filter bar filters entries", async ({ page }) => {
      const countBefore = await page.locator(".entry-item").count();
      expect(countBefore).toBeGreaterThan(1);

      await pressShortcut(page, "f", { ctrlKey: true });
      await page.waitForTimeout(200);

      const filterInput = page.locator(".filter-input");
      // Type a term that matches only some entries (e.g., "doc" for Documents)
      await filterInput.fill("doc");
      await page.waitForTimeout(300);

      const countAfter = await page.locator(".entry-item").count();
      expect(countAfter).toBeLessThan(countBefore);
      expect(countAfter).toBeGreaterThan(0);
    });

    test("Escape closes filter bar", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      const filterBar = page.locator(".filter-bar");
      await expect(filterBar).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(filterBar).not.toBeVisible();
    });

    test("filter clears when navigating to a new directory", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      await page.waitForTimeout(200);

      const filterInput = page.locator(".filter-input");
      await filterInput.fill("doc");
      await page.waitForTimeout(200);

      // Navigate into Documents
      const docsFolder = page.locator(".entry-item.directory", { hasText: "Documents" });
      await docsFolder.dblclick();
      await page.waitForTimeout(500);

      // Filter bar should be gone
      const filterBar = page.locator(".filter-bar");
      await expect(filterBar).not.toBeVisible();
    });

    test("clear button clears filter and closes bar", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      await page.waitForTimeout(200);

      const filterInput = page.locator(".filter-input");
      await filterInput.fill("test");
      await page.waitForTimeout(200);

      const clearBtn = page.locator(".filter-clear");
      await clearBtn.click();
      await page.waitForTimeout(200);

      // Filter bar should be closed
      const filterBar = page.locator(".filter-bar");
      await expect(filterBar).not.toBeVisible();
    });
  });

  // ==========================================================
  // 2. Shift+Delete Permanent Delete
  // ==========================================================
  test.describe(`Permanent Delete [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
    });

    test("Shift+Delete opens permanent delete dialog", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "Delete", { shiftKey: true });

      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
    });

    test("permanent delete dialog shows permanent delete text", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "Delete", { shiftKey: true });

      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
      // Dialog should mention "permanently deleted" or "Permanently delete"
      await expect(dialog).toContainText(/permanent/i);
    });

    test("regular Delete shows recycle bin text (not permanent)", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await page.keyboard.press("Delete");

      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Recycle Bin");
    });

    test("cancel closes permanent delete dialog", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "Delete", { shiftKey: true });

      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();

      await page.getByRole("button", { name: /cancel/i }).click();
      await expect(dialog).not.toBeVisible();
    });
  });
}

// ==========================================================
// 3. Space toggles Preview Pane
// ==========================================================
test.describe("Preview Pane Toggle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);
  });

  test("Space key toggles preview pane visibility", async ({ page }) => {
    // Check initial state of preview pane
    const previewPane = page.locator(".preview-pane");
    const initiallyVisible = await previewPane.isVisible();

    // Press Space to toggle
    await pressShortcut(page, " ", {});
    await page.waitForTimeout(300);

    const afterToggle = await previewPane.isVisible();
    expect(afterToggle).not.toBe(initiallyVisible);

    // Press Space again to toggle back
    await pressShortcut(page, " ", {});
    await page.waitForTimeout(300);

    const afterSecondToggle = await previewPane.isVisible();
    expect(afterSecondToggle).toBe(initiallyVisible);
  });

  test("Space does not toggle preview when input is focused", async ({ page }) => {
    const previewPane = page.locator(".preview-pane");
    const initiallyVisible = await previewPane.isVisible();

    // Open filter bar to get an input focused
    await pressShortcut(page, "f", { ctrlKey: true });
    await page.waitForTimeout(200);

    // Press Space while input is focused
    await page.keyboard.press("Space");
    await page.waitForTimeout(200);

    // Preview pane state should not change
    const afterSpace = await previewPane.isVisible();
    expect(afterSpace).toBe(initiallyVisible);
  });
});

// ==========================================================
// 4. Syntax Highlighting in Preview Pane
// ==========================================================
test.describe("Syntax Highlighting Preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);

    // Ensure preview pane is visible
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
      await page.waitForTimeout(300);
    }
  });

  test("selecting a code file shows syntax-highlighted preview", async ({ page }) => {
    // Click on index.ts
    const tsFile = page.locator(".entry-item", { hasText: "index.ts" });
    await tsFile.click();
    await page.waitForTimeout(500);

    // Preview should show highlighted code
    const previewCode = page.locator(".preview-code");
    await expect(previewCode).toBeVisible({ timeout: 3000 });

    // Should contain hljs class spans
    const hasHighlight = await previewCode.evaluate((el) => {
      return el.querySelector(".hljs") !== null;
    });
    expect(hasHighlight).toBe(true);
  });

  test("preview shows file name in header", async ({ page }) => {
    const tsFile = page.locator(".entry-item", { hasText: "index.ts" });
    await tsFile.click();
    await page.waitForTimeout(500);

    const filename = page.locator(".preview-filename");
    await expect(filename).toContainText("index.ts");
  });

  test("preview shows file info (size, modified)", async ({ page }) => {
    const tsFile = page.locator(".entry-item", { hasText: "index.ts" });
    await tsFile.click();
    await page.waitForTimeout(500);

    const infoSection = page.locator(".preview-info");
    await expect(infoSection).toBeVisible();
    await expect(infoSection).toContainText("Size");
    await expect(infoSection).toContainText("Modified");
  });
});

// ==========================================================
// 5. Paste to Same Folder
// ==========================================================
test.describe("Paste to Same Folder", () => {
  test("copy + paste in same directory does not show conflict dialog", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    // Select a file
    const file = page.locator(".entry-item:not(.directory)", { hasText: "readme.txt" });
    await file.click();

    // Copy it
    await pressShortcut(page, "c", { ctrlKey: true });
    const toast = page.locator(".toast.clipboard");
    await expect(toast).toBeVisible({ timeout: 2000 });

    // Paste in same directory
    await pressShortcut(page, "v", { ctrlKey: true });
    await page.waitForTimeout(1000);

    // The key behavior: no conflict dialog should appear for copy-to-same-dir
    const conflictDialog = page.locator(".conflict-dialog");
    await expect(conflictDialog).not.toBeVisible();

    // Also verify no error toast appeared
    const errorToast = page.locator(".toast.error");
    await expect(errorToast).not.toBeVisible();
  });
});
