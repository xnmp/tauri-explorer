import { test, expect } from "@playwright/test";

test.describe("Selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".file-list");
    // Wait for files to load
    await page.locator(".file-item").first().waitFor({ timeout: 5000 });
  });

  test.describe("Single Selection", () => {
    test("single-click on file selects it", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();
      await expect(file).toHaveClass(/selected/);
    });

    test("selected file has visual highlight", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();

      // Check for visual selection (border or background change)
      const styles = await file.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          background: computed.backgroundColor,
          border: computed.border,
        };
      });

      // Should have some visual indication (not default transparent)
      expect(
        styles.background !== "rgba(0, 0, 0, 0)" || styles.border !== "none"
      ).toBeTruthy();
    });

    test("clicking another file changes selection", async ({ page }) => {
      const files = page.locator(".file-item");
      const firstFile = files.nth(0);
      const secondFile = files.nth(1);

      await firstFile.click();
      await expect(firstFile).toHaveClass(/selected/);

      await secondFile.click();
      await expect(secondFile).toHaveClass(/selected/);
      await expect(firstFile).not.toHaveClass(/selected/);
    });

    test("clicking empty space deselects all", async ({ page }) => {
      const file = page.locator(".file-item").first();
      await file.click();
      await expect(file).toHaveClass(/selected/);

      // Click on empty space in file list content area
      await page.locator(".file-list .content").first().click({ position: { x: 10, y: 400 } });

      await expect(file).not.toHaveClass(/selected/);
    });
  });

  test.describe("Multi-Selection", () => {
    test("Ctrl+click adds to selection", async ({ page }) => {
      const files = page.locator(".file-item");
      const firstFile = files.nth(0);
      const secondFile = files.nth(1);

      await firstFile.click();
      await secondFile.click({ modifiers: ["Control"] });

      await expect(firstFile).toHaveClass(/selected/);
      await expect(secondFile).toHaveClass(/selected/);
    });

    test("Shift+click selects range", async ({ page }) => {
      const files = page.locator(".file-item");
      const count = await files.count();
      if (count < 3) {
        test.skip();
        return;
      }

      const firstFile = files.nth(0);
      const thirdFile = files.nth(2);

      await firstFile.click();
      await thirdFile.click({ modifiers: ["Shift"] });

      // All three should be selected
      await expect(files.nth(0)).toHaveClass(/selected/);
      await expect(files.nth(1)).toHaveClass(/selected/);
      await expect(files.nth(2)).toHaveClass(/selected/);
    });
  });

  test.describe("Drag Selection (Marquee)", () => {
    test("drag in empty space creates selection rectangle", async ({ page }) => {
      // The content div is the container for the file list content
      // We need to start the drag from a background element (content, details-view, or virtual-spacer)
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) {
        test.skip();
        return;
      }

      // Start drag from the bottom of the content area, below the file items
      // This ensures we hit the virtual-spacer-bottom or empty content area
      const startX = box.x + 50;
      const startY = box.y + box.height - 50; // Near the bottom

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 100, startY - 100);

      // Check for marquee rectangle
      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible({ timeout: 2000 });

      await page.mouse.up();
    });

    test("drag selection selects files within rectangle", async ({ page }) => {
      const files = page.locator(".file-item");
      const count = await files.count();
      if (count < 2) {
        test.skip();
        return;
      }

      // Get the content area which contains the file list
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) {
        test.skip();
        return;
      }

      // Start from bottom empty area and drag up to select files
      const startX = box.x + 50;
      const startY = box.y + box.height - 20; // Near the bottom (empty space)

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // Drag up to where the files are (toward the top)
      await page.mouse.move(startX + 200, box.y + 100);
      await page.mouse.up();

      // Wait a moment for selection to register
      await page.waitForTimeout(100);

      // At least one file should be selected
      const selectedCount = await page.locator(".file-item.selected").count();
      expect(selectedCount).toBeGreaterThan(0);
    });
  });
});
