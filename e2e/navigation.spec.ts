import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for app to load and file items to be visible
    await page.waitForSelector(".file-list");
    await page.locator(".file-item").first().waitFor({ timeout: 5000 });
    // Ensure breadcrumbs are populated
    await page.waitForFunction(() => {
      const bc = document.querySelector('.breadcrumbs-container');
      return bc && bc.textContent && bc.textContent.trim().length > 0;
    });
  });

  test.describe("Initial Load", () => {
    test("app loads without errors", async ({ page }) => {
      // Check no console errors
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      await page.waitForTimeout(1000);
      expect(errors.filter((e) => !e.includes("WebSocket"))).toHaveLength(0);
    });

    test("NavigationBar is visible", async ({ page }) => {
      await expect(page.locator(".navigation-bar")).toBeVisible();
    });

    test("Sidebar is visible with Quick Access section", async ({ page }) => {
      await expect(page.locator(".sidebar")).toBeVisible();
      await expect(page.getByText("Quick access")).toBeVisible();
    });

    test("FileList shows directory contents", async ({ page }) => {
      await expect(page.locator(".file-list")).toBeVisible();
      // Should have some files or folders
      const items = page.locator(".file-item");
      await expect(items.first()).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Folder Navigation", () => {
    test("double-click on folder navigates into it", async ({ page }) => {
      // Find a folder (folders have .directory class)
      const folder = page.locator(".file-item.directory").first();
      const folderName = await folder.locator(".name").textContent();

      // Double-click to navigate
      await folder.dblclick();

      // Wait for navigation
      await page.waitForTimeout(500);

      // Breadcrumbs should contain the folder name
      const breadcrumbs = page.locator(".breadcrumbs-container");
      await expect(breadcrumbs).toContainText(folderName || "");
    });

    test("single-click on folder only selects it", async ({ page }) => {
      const folder = page.locator(".file-item.directory").first();
      const initialBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();

      // Single click
      await folder.click();

      // Should be selected
      await expect(folder).toHaveClass(/selected/);

      // Path should NOT change
      const newBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
      expect(newBreadcrumbs).toBe(initialBreadcrumbs);
    });

    test("back button works after navigation", async ({ page }) => {
      const initialBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();

      // Navigate into a folder
      const folder = page.locator(".file-item.directory").first();
      await folder.dblclick();
      await page.waitForTimeout(500);

      // Click back
      await page.locator('button[title*="Back"], button[aria-label*="Back"]').click();
      await page.waitForTimeout(500);

      // Should be back at initial path
      const currentBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
      expect(currentBreadcrumbs).toBe(initialBreadcrumbs);
    });

    test("up button navigates to parent directory", async ({ page }) => {
      // Navigate into a folder first
      const folder = page.locator(".file-item.directory").first();
      await folder.dblclick();
      await page.waitForTimeout(500);

      const breadcrumbsBefore = await page.locator(".breadcrumbs-container").textContent();

      // Click up button
      await page.locator('button[title*="Up"], button[aria-label*="parent"]').click();
      await page.waitForTimeout(500);

      // Path should be shorter (parent)
      const breadcrumbsAfter = await page.locator(".breadcrumbs-container").textContent();
      expect(breadcrumbsAfter?.length).toBeLessThan(breadcrumbsBefore?.length || 0);
    });
  });

  test.describe("Keyboard Navigation", () => {
    test("F5 refreshes directory", async ({ page }) => {
      // Get initial file count
      const initialCount = await page.locator(".file-item").count();

      // Press F5
      await page.keyboard.press("F5");
      await page.waitForTimeout(500);

      // File list should still be visible with same content
      const newCount = await page.locator(".file-item").count();
      expect(newCount).toBe(initialCount);
    });

    test("Alt+Left goes back", async ({ page }) => {
      const initialBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();

      // Navigate forward
      const folder = page.locator(".file-item.directory").first();
      await folder.dblclick();
      await page.waitForTimeout(500);

      // Alt+Left to go back
      await page.keyboard.press("Alt+ArrowLeft");
      await page.waitForTimeout(500);

      const currentBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
      expect(currentBreadcrumbs).toBe(initialBreadcrumbs);
    });
  });
});
