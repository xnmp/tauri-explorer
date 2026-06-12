/**
 * Regression tests for Ctrl+P Quick Open.
 * Issue: tauri-explorer-m2x3
 */

import { test, expect } from "@playwright/test";

test.describe("Quick Open (Ctrl+P)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.waitForSelector(".file-list");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  });

  test("Ctrl+P opens quick open dialog", async ({ page }) => {
    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });
  });

  test("search input is focused when opened", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog .search-input")).toBeVisible();

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await expect(searchInput).toBeFocused();
  });

  test("typing in search input updates the value", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog .search-input")).toBeVisible();

    const searchInput = page.locator(".quick-open-dialog .search-input");
    await searchInput.pressSequentially("readme", { delay: 50 });
    await expect(searchInput).toHaveValue("readme");
  });

  test("typing does not clear input (regression)", async ({ page }) => {
    // This is the key regression test: typing should persist in the input
    // Previously, $effect re-running pruneNonExistent would reset query=""
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog .search-input")).toBeVisible();

    const searchInput = page.locator(".quick-open-dialog .search-input");

    // Type character by character with delays to allow async effects
    await searchInput.pressSequentially("test", { delay: 100 });
    await expect(searchInput).toHaveValue("test");
  });

  test("Escape closes quick open", async ({ page }) => {
    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(quickOpen).not.toBeVisible();
  });

  test("searching for a folder in a large project returns results", async ({ page }) => {
    // Navigate to Documents/project (100+ files, 15+ subdirectories)
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    // Open QuickOpen and search for "src" — a direct child folder
    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    const searchInput = quickOpen.locator(".search-input");
    await searchInput.pressSequentially("src", { delay: 50 });

    // Should find the "src" folder
    const resultItems = quickOpen.locator(".result-item");
    await expect(resultItems.first()).toBeVisible({ timeout: 5000 });

    await expect
      .poll(() => quickOpen.locator(".result-name").allTextContents(), { timeout: 5000 })
      .toContain("src");
  });

  test("searching for a nested folder returns results", async ({ page }) => {
    // Navigate to Documents/project
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    // Search for "components" — nested under src/
    const searchInput = quickOpen.locator(".search-input");
    await searchInput.pressSequentially("components", { delay: 50 });

    const resultItems = quickOpen.locator(".result-item");
    await expect(resultItems.first()).toBeVisible({ timeout: 5000 });

    await expect
      .poll(() => quickOpen.locator(".result-name").allTextContents(), { timeout: 5000 })
      .toContain("components");
  });

  test("searching for a file among many returns results", async ({ page }) => {
    // Navigate to Documents/project
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    // Search for "engine" — deeply nested in lib/core/engine.ts
    const searchInput = quickOpen.locator(".search-input");
    await searchInput.pressSequentially("engine", { delay: 50 });

    const resultItems = quickOpen.locator(".result-item");
    await expect(resultItems.first()).toBeVisible({ timeout: 5000 });

    await expect
      .poll(() => quickOpen.locator(".result-name").allTextContents(), { timeout: 5000 })
      .toContain("engine.ts");
  });

  test("folders rank above files with same match", async ({ page }) => {
    // Navigate to Documents/project
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    // Search for "config" — matches both config/ directory and config files
    const searchInput = quickOpen.locator(".search-input");
    await searchInput.pressSequentially("config", { delay: 50 });

    const resultItems = quickOpen.locator(".result-item");
    await expect(resultItems.first()).toBeVisible({ timeout: 5000 });

    // First result should settle as the directory once all results land
    await expect(resultItems.first()).toHaveClass(/is-directory/, { timeout: 5000 });
  });

  test("selection does not jump to the row under a stationary cursor when results re-render", async ({ page }) => {
    // Navigate to Documents/project for a deep result set
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    const searchInput = quickOpen.locator(".search-input");
    await searchInput.pressSequentially("co", { delay: 50 });

    const resultItems = quickOpen.locator(".result-item");
    await expect(resultItems.nth(3)).toBeVisible({ timeout: 5000 });
    // Let streaming settle — a results update revokes hover authorization.
    await page.waitForTimeout(400);

    // Park the cursor over the 4th row — a real multi-step movement, which
    // legitimately hover-selects it... (a single mousemove never authorizes:
    // the first observed position is indistinguishable from a synthetic event)
    const box = await resultItems.nth(3).boundingBox();
    if (!box) throw new Error("row 3 has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await expect(resultItems.nth(3)).toHaveClass(/selected/);

    // ...then KEEP IT STILL and continue typing. New results render under the
    // stationary cursor; selection must pin to the top result, not whatever
    // row happens to land under the pointer.
    await searchInput.pressSequentially("nfig", { delay: 80 });
    await expect
      .poll(() => quickOpen.locator(".result-name").allTextContents(), { timeout: 5000 })
      .toContain("config");

    await expect(resultItems.first()).toHaveClass(/selected/);
    // Give any late streamed chunks a chance to re-render, then re-assert.
    await page.waitForTimeout(400);
    await expect(resultItems.first()).toHaveClass(/selected/);
  });

  test("moving the mouse onto a row still hover-selects it", async ({ page }) => {
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    await quickOpen.locator(".search-input").pressSequentially("config", { delay: 50 });
    const resultItems = quickOpen.locator(".result-item");
    await expect(resultItems.nth(2)).toBeVisible({ timeout: 5000 });
    // Let streaming settle so a results update doesn't revoke the hover
    // authorization between the move and the assertion.
    await page.waitForTimeout(400);

    const first = await resultItems.nth(0).boundingBox();
    const third = await resultItems.nth(2).boundingBox();
    if (!first || !third) throw new Error("rows have no bounding box");
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2, { steps: 5 });

    await expect(resultItems.nth(2)).toHaveClass(/selected/);
  });

  test("re-opening quick open clears previous query", async ({ page }) => {
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog .search-input")).toBeVisible();
    const searchInput = page.locator(".quick-open-dialog .search-input");
    await searchInput.pressSequentially("test", { delay: 50 });
    await expect(searchInput).toHaveValue("test");

    await page.keyboard.press("Escape");
    await expect(page.locator(".quick-open-dialog")).toBeHidden();

    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog .search-input")).toBeVisible();
    await expect(searchInput).toHaveValue("");
  });
});
