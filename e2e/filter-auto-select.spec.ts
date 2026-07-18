/**
 * E2E tests for Ctrl+F filter auto-selecting the first matching entry.
 */

import { test, expect } from "./fixtures";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";

for (const viewMode of VIEW_MODES) {
  test.describe(`Filter Auto-Select [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
    });

    test("typing in filter selects the first matching entry", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });

      const filterInput = page.locator(".filter-input");
      await expect(filterInput).toBeVisible();
      await filterInput.fill("do");

      // Should have filtered entries
      await expect.poll(() => page.locator(".entry-item").count()).toBeGreaterThan(0);

      // First entry should be selected
      const firstEntry = page.locator(".entry-item").first();
      await expect(firstEntry).toHaveClass(/selected/);

      // Status bar should show "1 selected"
      const statusBar = page.locator(".status-bar");
      await expect(statusBar).toContainText("1 selected");
    });

    test("selection updates as filter narrows", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });

      const filterInput = page.locator(".filter-input");
      await expect(filterInput).toBeVisible();

      // Type partial match
      await filterInput.fill("d");

      const firstAfterD = page.locator(".entry-item").first();
      await expect(firstAfterD).toHaveClass(/selected/);
      const firstNameD = await firstAfterD.locator(".entry-name").textContent();

      // Narrow the filter further
      await filterInput.fill("down");

      const firstAfterDown = page.locator(".entry-item").first();
      await expect(firstAfterDown).toHaveClass(/selected/);
      const firstNameDown = await firstAfterDown.locator(".entry-name").textContent();
      expect(firstNameDown).toBe("Downloads");
    });

    test("clearing filter clears selection", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });

      const filterInput = page.locator(".filter-input");
      await expect(filterInput).toBeVisible();
      await filterInput.fill("doc");

      // First entry should be selected
      await expect(page.locator(".entry-item").first()).toHaveClass(/selected/);

      // Clear the filter
      await filterInput.fill("");

      // All entries should be back, first should be selected
      const entries = page.locator(".entry-item");
      const count = await entries.count();
      expect(count).toBeGreaterThan(2);
      await expect(entries.first()).toHaveClass(/selected/);
    });

    test("no match clears selection", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });

      const filterInput = page.locator(".filter-input");
      await expect(filterInput).toBeVisible();
      await filterInput.fill("zzzznonexistent");

      // No entries should be visible
      const entries = page.locator(".entry-item");
      await expect(entries).toHaveCount(0);

      // Status bar should show 0 items
      const statusBar = page.locator(".status-bar");
      await expect(statusBar).toContainText("0 items");
    });
  });
}
