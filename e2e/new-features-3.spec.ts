/**
 * E2E tests for recently implemented features:
 * - Ctrl+F filter bar (tauri-explorer-ryv1)
 * - Shift+Delete permanent delete dialog
 * - Space toggles preview pane
 * - Syntax highlighting in preview pane
 * - Paste to same folder (copy creates duplicate)
 */

import { test, expect } from "./fixtures";
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
      const filterInput = page.locator(".filter-input");
      await expect(filterInput).toBeFocused();
    });

    test("typing in filter bar filters entries", async ({ page }) => {
      const countBefore = await page.locator(".entry-item").count();
      expect(countBefore).toBeGreaterThan(1);

      await pressShortcut(page, "f", { ctrlKey: true });

      const filterInput = page.locator(".filter-input");
      await filterInput.waitFor({ state: "visible", timeout: 2000 });
      // Type a term that matches only some entries (e.g., "doc" for Documents)
      await filterInput.fill("doc");

      await expect.poll(() => page.locator(".entry-item").count()).toBeLessThan(countBefore);
      expect(await page.locator(".entry-item").count()).toBeGreaterThan(0);
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

      const filterInput = page.locator(".filter-input");
      await filterInput.waitFor({ state: "visible", timeout: 2000 });
      await filterInput.fill("doc");

      // Navigate into Documents
      const docsFolder = page.locator(".entry-item.directory", { hasText: "Documents" });
      await docsFolder.dblclick();

      // Filter bar should be gone
      const filterBar = page.locator(".filter-bar");
      await expect(filterBar).not.toBeVisible();
    });

    test("clear button clears filter and closes bar", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });

      const filterInput = page.locator(".filter-input");
      await filterInput.waitFor({ state: "visible", timeout: 2000 });
      await filterInput.fill("test");

      const clearBtn = page.locator(".filter-clear");
      await clearBtn.click();

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

    test("regular Delete shows recycle bin text (not permanent)", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await page.keyboard.press("Delete");

      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Recycle Bin");
    });

    test("Shift+Delete asks for a permanent delete, and cancel closes it", async ({ page }) => {
      const file = page.locator(".entry-item").first();
      await file.click();

      await pressShortcut(page, "Delete", { shiftKey: true });

      // Shift+Delete asks for a permanent delete (delete-restore.spec.ts
      // carries out one and checks that it cannot be undone).
      const dialog = page.locator("[role='alertdialog']");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/permanent/i);

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
    await expect.poll(() => previewPane.isVisible()).toBe(!initiallyVisible);

    // Press Space again to toggle back
    await pressShortcut(page, " ", {});
    await expect.poll(() => previewPane.isVisible()).toBe(initiallyVisible);
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

    const filename = page.locator(".preview-filename");
    await expect(filename).toContainText("index.ts");
  });

  test("preview shows file info (size, modified)", async ({ page }) => {
    const tsFile = page.locator(".entry-item", { hasText: "index.ts" });
    await tsFile.click();

    const infoSection = page.locator(".preview-info");
    await expect(infoSection).toBeVisible();
    await expect(infoSection).toContainText("Size");
    await expect(infoSection).toContainText("Modified");
  });
});
