/**
 * E2E tests for Ctrl+F filter auto-selecting the first matching entry.
 */

import { test, expect } from "@playwright/test";
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
      await page.waitForTimeout(200);

      const filterInput = page.locator(".filter-input");
      await filterInput.fill("do");
      await page.waitForTimeout(300);

      // Should have filtered entries
      const entries = page.locator(".entry-item");
      const count = await entries.count();
      expect(count).toBeGreaterThan(0);

      // First entry should be selected
      const firstEntry = entries.first();
      await expect(firstEntry).toHaveClass(/selected/);

      // Status bar should show "1 selected"
      const statusBar = page.locator(".status-bar");
      await expect(statusBar).toContainText("1 selected");
    });

    test("selection updates as filter narrows", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      await page.waitForTimeout(200);

      const filterInput = page.locator(".filter-input");

      // Type partial match
      await filterInput.fill("d");
      await page.waitForTimeout(200);

      const firstAfterD = page.locator(".entry-item").first();
      await expect(firstAfterD).toHaveClass(/selected/);
      const firstNameD = await firstAfterD.locator(".entry-name").textContent();

      // Narrow the filter further
      await filterInput.fill("down");
      await page.waitForTimeout(200);

      const firstAfterDown = page.locator(".entry-item").first();
      await expect(firstAfterDown).toHaveClass(/selected/);
      const firstNameDown = await firstAfterDown.locator(".entry-name").textContent();
      expect(firstNameDown).toBe("Downloads");
    });

    test("clearing filter clears selection", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      await page.waitForTimeout(200);

      const filterInput = page.locator(".filter-input");
      await filterInput.fill("doc");
      await page.waitForTimeout(200);

      // First entry should be selected
      await expect(page.locator(".entry-item").first()).toHaveClass(/selected/);

      // Clear the filter
      await filterInput.fill("");
      await page.waitForTimeout(200);

      // All entries should be back, first should be selected
      const entries = page.locator(".entry-item");
      const count = await entries.count();
      expect(count).toBeGreaterThan(2);
      await expect(entries.first()).toHaveClass(/selected/);
    });

    test("no match clears selection", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      await page.waitForTimeout(200);

      const filterInput = page.locator(".filter-input");
      await filterInput.fill("zzzznonexistent");
      await page.waitForTimeout(200);

      // No entries should be visible
      const entries = page.locator(".entry-item");
      await expect(entries).toHaveCount(0);

      // Status bar should show 0 items
      const statusBar = page.locator(".status-bar");
      await expect(statusBar).toContainText("0 items");
    });
  });
}
