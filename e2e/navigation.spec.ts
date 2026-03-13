import { test, expect } from "@playwright/test";

// Helper: navigate to home directory so tests have multiple folders available
const HOME_URL = "/?path=/home/user";

/** Wait for the file list to be populated with entry items */
async function waitForEntries(page: import("@playwright/test").Page) {
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.waitForSelector(".breadcrumbs-container .crumb");
}

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
  });

  test.describe("Initial Load", () => {
    test("app loads without errors", async ({ page }) => {
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
      const items = page.locator(".entry-item");
      await expect(items.first()).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Folder Navigation", () => {
    test("double-click on folder navigates into it", async ({ page }) => {
      // At /home/user we should see Documents, Downloads, etc.
      const folder = page.locator(".entry-item.directory").first();
      const folderName = await folder.locator(".entry-name").textContent();
      expect(folderName).toBeTruthy();

      // Double-click to navigate into the folder
      await folder.dblclick();

      // Breadcrumbs should update to contain the folder name
      const breadcrumbs = page.locator(".breadcrumbs-container");
      await expect(breadcrumbs).toContainText(folderName!, { timeout: 5000 });
    });

    test("single-click on folder only selects it", async ({ page }) => {
      const folder = page.locator(".entry-item.directory").first();
      const initialBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();

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
      const folder = page.locator(".entry-item.directory").first();
      await folder.dblclick();
      await page.locator(".entry-item").first().waitFor({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);

      // Click back
      await page.locator('button[title*="Back"], button[aria-label*="Back"]').click();
      await page.waitForTimeout(500);

      // Should be back at initial path
      const currentBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
      expect(currentBreadcrumbs).toBe(initialBreadcrumbs);
    });

    test("up button navigates to parent directory", async ({ page }) => {
      // Navigate into a folder first so we can go up
      const folder = page.locator(".entry-item.directory").first();
      const folderName = await folder.locator(".entry-name").textContent();
      await folder.dblclick();

      // Wait for navigation and breadcrumbs to show the folder name
      const breadcrumbs = page.locator(".breadcrumbs-container");
      await expect(breadcrumbs).toContainText(folderName!, { timeout: 5000 });

      // Click up button
      await page.locator('button[aria-label="Go up one level"]').click();
      await page.waitForTimeout(500);

      // Should no longer contain the folder name (back at parent)
      const breadcrumbsAfter = await breadcrumbs.textContent();
      // At home dir, breadcrumbs collapse to just the home icon
      expect(breadcrumbsAfter?.includes(folderName!)).toBe(false);
    });
  });

  test.describe("Keyboard Navigation", () => {
    test("F5 refreshes directory", async ({ page }) => {
      const initialCount = await page.locator(".entry-item").count();

      await page.keyboard.press("F5");
      await page.waitForTimeout(500);

      const newCount = await page.locator(".entry-item").count();
      expect(newCount).toBe(initialCount);
    });

    test("Alt+Left goes back", async ({ page }) => {
      const initialBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();

      // Navigate forward
      const folder = page.locator(".entry-item.directory").first();
      await folder.dblclick();
      await page.waitForTimeout(500);

      // Ctrl+Alt+Left to go back
      await page.keyboard.press("Control+Alt+ArrowLeft");
      await page.waitForTimeout(500);

      const currentBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
      expect(currentBreadcrumbs).toBe(initialBreadcrumbs);
    });
  });
});
