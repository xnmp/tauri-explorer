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

      // Click on empty space in file list
      await page.locator(".file-list .content, .details-view").click({ position: { x: 10, y: 400 } });

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
      const fileList = page.locator(".content, .details-view");

      // Start drag in empty space
      await fileList.hover({ position: { x: 50, y: 100 } });
      await page.mouse.down();
      await page.mouse.move(200, 300);

      // Check for marquee rectangle
      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible();

      await page.mouse.up();
    });

    test("drag selection selects files within rectangle", async ({ page }) => {
      const files = page.locator(".file-item");
      const count = await files.count();
      if (count < 2) {
        test.skip();
        return;
      }

      const fileList = page.locator(".content, .details-view");
      const box = await fileList.boundingBox();
      if (!box) return;

      // Drag across multiple files
      await page.mouse.move(box.x + 10, box.y + 50);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 10, box.y + 150);
      await page.mouse.up();

      // At least one file should be selected
      const selectedCount = await page.locator(".file-item.selected").count();
      expect(selectedCount).toBeGreaterThan(0);
    });
  });
});
