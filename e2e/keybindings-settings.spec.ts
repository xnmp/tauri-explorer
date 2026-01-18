/**
 * Keyboard Shortcuts Settings UI E2E Tests
 * Tests the keybindings customization UI in the Settings dialog.
 */

import { test, expect } from "@playwright/test";

async function waitForFileList(page: import("@playwright/test").Page) {
  await page.waitForSelector(".file-list");
  await page.locator(".file-item").first().waitFor({ timeout: 10000 });
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(100);
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  return dialog;
}

async function closeSettings(page: import("@playwright/test").Page) {
  // Click the close button instead of pressing Escape
  // (Escape might be captured by the keybindings recording handler)
  const closeBtn = page.locator(".settings-dialog .close-btn");
  await closeBtn.click();
  await page.waitForTimeout(100);
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).not.toBeVisible();
}

test.describe("Keyboard Shortcuts Settings UI", () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage to start fresh
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
  });

  test("Settings dialog opens with Ctrl+,", async ({ page }) => {
    await openSettings(page);

    // Verify dialog has the title
    const title = page.locator("#settings-title");
    await expect(title).toHaveText("Settings");

    // Take screenshot
    await page.screenshot({ path: "screenshots/settings-dialog-open.png" });
  });

  test("Keyboard Shortcuts section exists with grouped commands", async ({ page }) => {
    await openSettings(page);

    // Find the Keyboard Shortcuts section
    const sectionTitle = page.locator(".section-title", { hasText: "Keyboard Shortcuts" });
    await expect(sectionTitle).toBeVisible();

    // Check for category groups
    const categoryGroups = page.locator(".category-group");
    const groupCount = await categoryGroups.count();
    expect(groupCount).toBeGreaterThan(0);

    // Check for category titles within the keybindings section
    const categoryTitles = page.locator(".keybindings-settings .category-title");
    const titleCount = await categoryTitles.count();
    expect(titleCount).toBeGreaterThan(0);

    // Check some expected categories exist
    const keybindingsSection = page.locator(".keybindings-settings");
    await expect(keybindingsSection).toContainText(/(Navigation|File|View|Selection)/i);

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-grouped.png" });
  });

  test("Search/filter functionality works", async ({ page }) => {
    await openSettings(page);

    // Find the search input
    const searchInput = page.locator(".keybindings-settings .search-input");
    await expect(searchInput).toBeVisible();

    // Get initial shortcut count
    const initialRows = page.locator(".shortcut-row");
    const initialCount = await initialRows.count();
    expect(initialCount).toBeGreaterThan(0);

    // Type a search query
    await searchInput.fill("copy");
    await page.waitForTimeout(100);

    // Filtered results should be fewer
    const filteredRows = page.locator(".shortcut-row");
    const filteredCount = await filteredRows.count();
    expect(filteredCount).toBeLessThan(initialCount);
    expect(filteredCount).toBeGreaterThan(0);

    // Clear search to see all again
    await searchInput.fill("");
    await page.waitForTimeout(100);
    const afterClearCount = await page.locator(".shortcut-row").count();
    expect(afterClearCount).toBe(initialCount);

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-search.png" });
  });

  test("Click on shortcut to enter recording mode", async ({ page }) => {
    await openSettings(page);

    // Find a shortcut button
    const shortcutBtn = page.locator(".shortcut-btn").first();
    await expect(shortcutBtn).toBeVisible();

    // Click to enter recording mode
    await shortcutBtn.click();
    await page.waitForTimeout(100);

    // Check for "Press keys..." indicator
    const recordingText = page.locator(".recording-text");
    await expect(recordingText).toBeVisible();
    await expect(recordingText).toHaveText("Press keys...");

    // Check for cancel button
    const cancelBtn = page.locator(".cancel-btn");
    await expect(cancelBtn).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-recording-mode.png" });
  });

  test("Escape cancels recording mode", async ({ page }) => {
    await openSettings(page);

    // Click a shortcut to enter recording mode
    const shortcutBtn = page.locator(".shortcut-btn").first();
    await shortcutBtn.click();
    await page.waitForTimeout(100);

    // Verify in recording mode
    const recordingText = page.locator(".recording-text");
    await expect(recordingText).toBeVisible();

    // Press Escape to cancel - need to focus the keybindings area
    const keybindingsArea = page.locator(".keybindings-settings");
    await keybindingsArea.focus();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // Recording mode should be cancelled
    await expect(recordingText).not.toBeVisible();

    // Shortcut button should be visible again
    await expect(shortcutBtn).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-escape-cancel.png" });
  });

  test("Cancel button works in recording mode", async ({ page }) => {
    await openSettings(page);

    // Click a shortcut to enter recording mode
    const shortcutBtn = page.locator(".shortcut-btn").first();
    await shortcutBtn.click();
    await page.waitForTimeout(100);

    // Click the cancel button
    const cancelBtn = page.locator(".cancel-btn");
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await page.waitForTimeout(100);

    // Recording mode should be cancelled
    await expect(cancelBtn).not.toBeVisible();
    await expect(shortcutBtn).toBeVisible();
  });

  test("Recording a new shortcut works", async ({ page }) => {
    await openSettings(page);

    // Find the Copy command shortcut
    const copyRow = page.locator(".shortcut-row", { hasText: "Copy" }).first();
    await expect(copyRow).toBeVisible();

    const shortcutBtn = copyRow.locator(".shortcut-btn");
    const originalShortcut = await shortcutBtn.textContent();
    expect(originalShortcut).toContain("Ctrl");
    expect(originalShortcut).toContain("C");

    // Click to enter recording mode
    await shortcutBtn.click();
    await page.waitForTimeout(100);

    // Verify in recording mode
    const recordingText = copyRow.locator(".recording-text");
    await expect(recordingText).toBeVisible();

    // Focus the keybindings area and record a new shortcut
    const keybindingsArea = page.locator(".keybindings-settings");
    await keybindingsArea.focus();

    // Press a non-conflicting shortcut (Ctrl+Shift+C should not conflict with Copy)
    await page.keyboard.press("Control+Shift+c");
    await page.waitForTimeout(200);

    // Check if the shortcut was updated
    await expect(recordingText).not.toBeVisible();
    const newShortcutBtn = copyRow.locator(".shortcut-btn");
    const newShortcut = await newShortcutBtn.textContent();

    // Should show Ctrl+Shift+C now
    expect(newShortcut).toContain("Ctrl");
    expect(newShortcut).toContain("Shift");
    expect(newShortcut).toContain("C");

    // Should have reset button now (customized indicator)
    const resetBtn = copyRow.locator(".reset-btn");
    await expect(resetBtn).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-new-shortcut.png" });
  });

  test("Conflict detection prevents duplicate shortcuts", async ({ page }) => {
    await openSettings(page);

    // Find a shortcut row (not the Paste row)
    const copyRow = page.locator(".shortcut-row", { hasText: "Copy" }).first();
    await expect(copyRow).toBeVisible();

    const shortcutBtn = copyRow.locator(".shortcut-btn");

    // Click to enter recording mode
    await shortcutBtn.click();
    await page.waitForTimeout(100);

    // Try to assign Ctrl+V (which is Paste shortcut)
    const keybindingsArea = page.locator(".keybindings-settings");
    await keybindingsArea.focus();
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(200);

    // Should show conflict warning
    const conflictWarning = page.locator(".conflict-warning");
    await expect(conflictWarning).toBeVisible();
    await expect(conflictWarning).toContainText(/Conflicts with/);

    // Recording mode should still be active (not accepted the conflicting shortcut)
    const recordingText = copyRow.locator(".recording-text");
    await expect(recordingText).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-conflict-detected.png" });

    // Cancel to exit recording mode
    await page.keyboard.press("Escape");
  });

  test("Reset button on individual shortcuts works", async ({ page }) => {
    await openSettings(page);

    // First, customize a shortcut
    const copyRow = page.locator(".shortcut-row", { hasText: "Copy" }).first();
    const shortcutBtn = copyRow.locator(".shortcut-btn");

    // Record original value
    const originalShortcut = await shortcutBtn.textContent();

    // Click to enter recording mode and set new shortcut
    await shortcutBtn.click();
    await page.waitForTimeout(100);

    const keybindingsArea = page.locator(".keybindings-settings");
    await keybindingsArea.focus();
    await page.keyboard.press("Control+Shift+c");
    await page.waitForTimeout(200);

    // Verify it changed
    const newShortcutBtn = copyRow.locator(".shortcut-btn");
    const newShortcut = await newShortcutBtn.textContent();
    expect(newShortcut).not.toBe(originalShortcut);

    // Reset button should be visible
    const resetBtn = copyRow.locator(".reset-btn");
    await expect(resetBtn).toBeVisible();

    // Click reset
    await resetBtn.click();
    await page.waitForTimeout(100);

    // Should be back to original
    const resetShortcutBtn = copyRow.locator(".shortcut-btn");
    const resetShortcut = await resetShortcutBtn.textContent();
    expect(resetShortcut).toContain("Ctrl");
    expect(resetShortcut).toContain("C");
    expect(resetShortcut).not.toContain("Shift");

    // Reset button should be hidden now
    await expect(resetBtn).not.toBeVisible();

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-reset-individual.png" });
  });

  test("Reset All button works", async ({ page }) => {
    await openSettings(page);

    // First, customize a few shortcuts
    const rows = page.locator(".shortcut-row");
    const firstRow = rows.first();
    const secondRow = rows.nth(1);

    // Customize first shortcut
    const firstBtn = firstRow.locator(".shortcut-btn");
    await firstBtn.click();
    await page.waitForTimeout(100);

    const keybindingsArea = page.locator(".keybindings-settings");
    await keybindingsArea.focus();
    await page.keyboard.press("Control+Alt+1");
    await page.waitForTimeout(200);

    // Customize second shortcut
    const secondBtn = secondRow.locator(".shortcut-btn");
    await secondBtn.click();
    await page.waitForTimeout(100);

    await keybindingsArea.focus();
    await page.keyboard.press("Control+Alt+2");
    await page.waitForTimeout(200);

    // Both should have reset buttons now
    await expect(firstRow.locator(".reset-btn")).toBeVisible();
    await expect(secondRow.locator(".reset-btn")).toBeVisible();

    // Take screenshot before reset
    await page.screenshot({ path: "screenshots/keybindings-before-reset-all.png" });

    // Click Reset All button
    const resetAllBtn = page.locator(".reset-all-btn");
    await expect(resetAllBtn).toBeVisible();
    await resetAllBtn.click();
    await page.waitForTimeout(100);

    // All reset buttons should be gone
    const resetBtns = page.locator(".reset-btn");
    await expect(resetBtns).toHaveCount(0);

    // Take screenshot after reset
    await page.screenshot({ path: "screenshots/keybindings-after-reset-all.png" });
  });

  test("Persistence: customized shortcuts persist after close/reopen", async ({ page }) => {
    await openSettings(page);

    // Customize a shortcut
    const copyRow = page.locator(".shortcut-row", { hasText: "Copy" }).first();
    const shortcutBtn = copyRow.locator(".shortcut-btn");

    await shortcutBtn.click();
    await page.waitForTimeout(100);

    const keybindingsArea = page.locator(".keybindings-settings");
    await keybindingsArea.focus();
    await page.keyboard.press("Control+Shift+y");
    await page.waitForTimeout(200);

    // Verify it changed
    const newShortcutBtn = copyRow.locator(".shortcut-btn");
    await expect(newShortcutBtn).toContainText("Y");
    await expect(newShortcutBtn).toContainText("Shift");

    // Close settings
    await closeSettings(page);

    // Reopen settings
    await openSettings(page);

    // The customization should persist
    const reopenedCopyRow = page.locator(".shortcut-row", { hasText: "Copy" }).first();
    const reopenedShortcutBtn = reopenedCopyRow.locator(".shortcut-btn");
    await expect(reopenedShortcutBtn).toContainText("Y");
    await expect(reopenedShortcutBtn).toContainText("Shift");

    // Reset button should still be visible
    const resetBtn = reopenedCopyRow.locator(".reset-btn");
    await expect(resetBtn).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-persistence.png" });

    // Clean up: reset all to defaults
    const resetAllBtn = page.locator(".reset-all-btn");
    await resetAllBtn.click();
  });

  test("Customized shortcuts are highlighted", async ({ page }) => {
    await openSettings(page);

    // Customize a shortcut
    const copyRow = page.locator(".shortcut-row", { hasText: "Copy" }).first();

    // Initially should not have customized class
    await expect(copyRow).not.toHaveClass(/customized/);

    const shortcutBtn = copyRow.locator(".shortcut-btn");
    await shortcutBtn.click();
    await page.waitForTimeout(100);

    const keybindingsArea = page.locator(".keybindings-settings");
    await keybindingsArea.focus();
    await page.keyboard.press("Control+Shift+c");
    await page.waitForTimeout(200);

    // Now should have customized class
    await expect(copyRow).toHaveClass(/customized/);

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-customized-highlight.png" });

    // Clean up
    const resetBtn = copyRow.locator(".reset-btn");
    await resetBtn.click();
  });

  test("No results message when search has no matches", async ({ page }) => {
    await openSettings(page);

    const searchInput = page.locator(".keybindings-settings .search-input");
    await searchInput.fill("xyznonexistent123");
    await page.waitForTimeout(100);

    // Should show no results message
    const noResults = page.locator(".no-results");
    await expect(noResults).toBeVisible();
    await expect(noResults).toHaveText("No shortcuts found");

    // Take screenshot
    await page.screenshot({ path: "screenshots/keybindings-no-results.png" });
  });
});
