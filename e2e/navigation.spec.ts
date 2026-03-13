import { test, expect } from "@playwright/test";
import { VIEW_MODES, HOME_URL, waitForEntries, switchViewMode, type ViewMode } from "./helpers";

for (const viewMode of VIEW_MODES) {
  test.describe(`Navigation [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(HOME_URL);
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
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
        const folder = page.locator(".entry-item.directory").first();
        const folderName = await folder.locator(".entry-name").textContent();
        expect(folderName).toBeTruthy();

        await folder.dblclick();

        const breadcrumbs = page.locator(".breadcrumbs-container");
        await expect(breadcrumbs).toContainText(folderName!, { timeout: 5000 });
      });

      test("single-click on folder only selects it", async ({ page }) => {
        const folder = page.locator(".entry-item.directory").first();
        const initialBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();

        await folder.click();

        await expect(folder).toHaveClass(/selected/);

        const newBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
        expect(newBreadcrumbs).toBe(initialBreadcrumbs);
      });

      test("back button works after navigation", async ({ page }) => {
        const initialBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();

        const folder = page.locator(".entry-item.directory").first();
        await folder.dblclick();
        await page.locator(".entry-item").first().waitFor({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);

        await page.locator('button[title*="Back"], button[aria-label*="Back"]').click();
        await page.waitForTimeout(500);

        const currentBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
        expect(currentBreadcrumbs).toBe(initialBreadcrumbs);
      });

      test("up button navigates to parent directory", async ({ page }) => {
        const folder = page.locator(".entry-item.directory").first();
        const folderName = await folder.locator(".entry-name").textContent();
        await folder.dblclick();

        const breadcrumbs = page.locator(".breadcrumbs-container");
        await expect(breadcrumbs).toContainText(folderName!, { timeout: 5000 });

        await page.locator('button[aria-label="Go up one level"]').click();
        await page.waitForTimeout(500);

        const breadcrumbsAfter = await breadcrumbs.textContent();
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

        const folder = page.locator(".entry-item.directory").first();
        await folder.dblclick();
        await page.waitForTimeout(500);

        await page.keyboard.press("Control+Alt+ArrowLeft");
        await page.waitForTimeout(500);

        const currentBreadcrumbs = await page.locator(".breadcrumbs-container").textContent();
        expect(currentBreadcrumbs).toBe(initialBreadcrumbs);
      });
    });
  });
}
