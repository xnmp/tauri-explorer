/**
 * E2E tests for resizable preview pane (tauri-explorer-zden)
 */

import { test, expect } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Resizable Preview Pane", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);

    // Ensure preview pane is visible
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
      await page.waitForTimeout(300);
    }
    await expect(previewPane).toBeVisible();
  });

  test("preview pane has a visible resize handle", async ({ page }) => {
    const previewPane = page.locator(".preview-pane");
    const handle = previewPane.locator(".resize-handle");
    await expect(handle).toBeAttached();

    // Handle should have col-resize cursor
    const cursor = await handle.evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe("col-resize");
  });

  test("dragging resize handle changes preview pane width", async ({ page }) => {
    const previewPane = page.locator(".preview-pane");
    const handle = previewPane.locator(".resize-handle");

    const initialBox = await previewPane.boundingBox();
    expect(initialBox).not.toBeNull();
    const initialWidth = initialBox!.width;

    // Drag the handle 80px to the left (should increase width)
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 80, startY, { steps: 5 });
    await page.mouse.up();

    const newBox = await previewPane.boundingBox();
    expect(newBox).not.toBeNull();
    // Width should have increased by approximately 80px
    expect(newBox!.width).toBeGreaterThan(initialWidth + 40);
  });

  test("resize width is persisted in settings", async ({ page }) => {
    const previewPane = page.locator(".preview-pane");
    const handle = previewPane.locator(".resize-handle");
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    // Drag to resize
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 100, startY, { steps: 5 });
    await page.mouse.up();

    // Check settings were persisted
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      return raw ? JSON.parse(raw) : null;
    });
    expect(stored).not.toBeNull();
    expect(stored.previewPaneWidth).toBeGreaterThan(0);
  });

  test("resize respects minimum width", async ({ page }) => {
    const previewPane = page.locator(".preview-pane");
    const handle = previewPane.locator(".resize-handle");
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    // Drag far to the right (should shrink, but not below min)
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 500, startY, { steps: 5 });
    await page.mouse.up();

    const box = await previewPane.boundingBox();
    expect(box).not.toBeNull();
    // Minimum width is 160px
    expect(box!.width).toBeGreaterThanOrEqual(158); // small tolerance for borders
  });

  test("resize respects maximum width", async ({ page }) => {
    const previewPane = page.locator(".preview-pane");
    const handle = previewPane.locator(".resize-handle");
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    // Drag far to the left (should grow, but not above max)
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 800, startY, { steps: 5 });
    await page.mouse.up();

    const box = await previewPane.boundingBox();
    expect(box).not.toBeNull();
    // Maximum width is 600px
    expect(box!.width).toBeLessThanOrEqual(602); // small tolerance for borders
  });
});
