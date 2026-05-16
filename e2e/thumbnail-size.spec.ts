/**
 * E2E Tests for thumbnail size setting (Small/Medium/Large/Extra Large).
 * Issue: tauri-explorer-jc83
 *
 * Verifies that changing the Thumbnail Size dropdown in Settings
 * updates tile icon dimensions and grid layout in TilesView.
 */

import { test, expect } from "@playwright/test";

async function waitForFileList(page: import("@playwright/test").Page) {
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 10000 });
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(100);
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  return dialog;
}

async function switchToTilesView(page: import("@playwright/test").Page) {
  // Clear selection, right-click, pick Tiles
  await page.keyboard.press("Escape");
  await page.waitForTimeout(50);

  const content = page.locator(".file-list .content").first();
  const box = await content.boundingBox();
  const clickY = box ? Math.round(box.height / 2) : 300;
  await content.click({ button: "right", position: { x: 10, y: clickY } });

  const contextMenu = page.locator(".context-menu");
  await contextMenu.waitFor({ state: "visible", timeout: 2000 });

  const tilesOption = contextMenu.locator('.menu-item:has-text("Tiles")');
  await tilesOption.click();
  await page.waitForTimeout(200);
  await page.locator(".tiles-view .entry-item").first().waitFor({ timeout: 3000 });
}

async function setThumbnailSize(
  page: import("@playwright/test").Page,
  size: "small" | "medium" | "large" | "xlarge",
) {
  const dialog = await openSettings(page);

  // Find the Thumbnail Size row and its select
  const row = dialog.locator(".setting-row").filter({
    has: page.locator(".setting-label", { hasText: /^Thumbnail Size$/ }),
  });
  await row.scrollIntoViewIfNeeded();

  const select = row.locator("select");
  await select.selectOption(size);
  await page.waitForTimeout(50);

  // Close settings
  await dialog.locator(".close-btn").click();
  await page.waitForTimeout(100);
}

test.describe("Thumbnail Size Setting", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
  });

  test("settings dialog shows Thumbnail Size dropdown with 4 options", async ({ page }) => {
    const dialog = await openSettings(page);

    const row = dialog.locator(".setting-row").filter({
      has: page.locator(".setting-label", { hasText: /^Thumbnail Size$/ }),
    });
    await expect(row).toBeVisible();

    const select = row.locator("select");
    const options = await select.locator("option").allTextContents();
    expect(options).toEqual(["Small", "Medium", "Large", "Extra Large"]);

    // Default should be "small"
    await expect(select).toHaveValue("small");
  });

  test("changing to Medium increases tile icon size", async ({ page }) => {
    await switchToTilesView(page);

    // Get initial tile icon size (should be 48px for small)
    const initialSize = await page.locator(".tile-icon").first().evaluate((el) => {
      return getComputedStyle(el).width;
    });
    expect(initialSize).toBe("48px");

    // Change to Medium
    await setThumbnailSize(page, "medium");
    await page.waitForTimeout(200);

    // Tile icon should now be 64px
    const newSize = await page.locator(".tile-icon").first().evaluate((el) => {
      return getComputedStyle(el).width;
    });
    expect(newSize).toBe("64px");
  });

  test("changing to Large increases tile icon size to 96px", async ({ page }) => {
    await switchToTilesView(page);

    await setThumbnailSize(page, "large");
    await page.waitForTimeout(200);

    const size = await page.locator(".tile-icon").first().evaluate((el) => {
      return getComputedStyle(el).width;
    });
    expect(size).toBe("96px");
  });

  test("grid column min-width updates with thumbnail size", async ({ page }) => {
    await switchToTilesView(page);

    // Check CSS custom property for small (default)
    const smallMinCol = await page.locator(".tiles-view").evaluate((el) => {
      return getComputedStyle(el).getPropertyValue("--tile-min-col").trim();
    });
    expect(smallMinCol).toBe("84px");

    // Switch to xlarge
    await setThumbnailSize(page, "xlarge");
    await page.waitForTimeout(200);

    const xlargeMinCol = await page.locator(".tiles-view").evaluate((el) => {
      return getComputedStyle(el).getPropertyValue("--tile-min-col").trim();
    });
    expect(xlargeMinCol).toBe("172px");
  });

  test("image thumbnails render at Large size in tiles view", async ({ page }) => {
    // Navigate to Pictures which has image files
    await page.goto("/?path=/home/user/Pictures");
    await waitForFileList(page);
    await switchToTilesView(page);

    // Set to Large
    await setThumbnailSize(page, "large");
    await page.waitForTimeout(300);

    // Find a thumbnail container (image files get ThumbnailImage, not FileIcon)
    const thumbnailContainer = page.locator(".tile-icon .thumbnail-container").first();
    await expect(thumbnailContainer).toBeVisible({ timeout: 5000 });

    // Thumbnail container display size matches tile icon size (96px for large)
    const containerSize = await thumbnailContainer.evaluate((el) => {
      return getComputedStyle(el).width;
    });
    expect(containerSize).toBe("96px");
  });

  test("image thumbnails render at Extra Large size in tiles view", async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures");
    await waitForFileList(page);
    await switchToTilesView(page);

    // Set to Extra Large
    await setThumbnailSize(page, "xlarge");
    await page.waitForTimeout(300);

    const thumbnailContainer = page.locator(".tile-icon .thumbnail-container").first();
    await expect(thumbnailContainer).toBeVisible({ timeout: 5000 });

    // Display size matches tile icon (128px for xlarge)
    const containerSize = await thumbnailContainer.evaluate((el) => {
      return getComputedStyle(el).width;
    });
    expect(containerSize).toBe("128px");
  });

  test("thumbnail size persists across page reloads", async ({ page }) => {
    await setThumbnailSize(page, "large");
    await page.waitForTimeout(200);

    // Reload the page
    await page.reload();
    await waitForFileList(page);

    // Re-open settings and verify the value persisted
    const dialog = await openSettings(page);
    const row = dialog.locator(".setting-row").filter({
      has: page.locator(".setting-label", { hasText: /^Thumbnail Size$/ }),
    });
    const select = row.locator("select");
    await expect(select).toHaveValue("large");
  });
});
