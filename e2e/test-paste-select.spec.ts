/**
 * E2E test for paste-select feature (tauri-explorer-zktf)
 * Verifies that pasted files are selected after paste completes.
 */
import { test, expect } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Paste selects pasted files", () => {
  test("cross-dir paste selects the pasted file", async ({ page }) => {
    await page.goto("http://localhost:1420/?path=/home/user");
    await waitForEntries(page);

    // Navigate into Documents
    const docsDir = page.locator(".entry-item", { hasText: "Documents" }).first();
    await docsDir.dblclick();
    await page.waitForTimeout(500);
    await waitForEntries(page);

    // Copy a file
    const file = page.locator(".entry-item:not(.directory)").first();
    await file.click();
    await page.waitForTimeout(200);
    const fileName = await file.locator(".entry-name").textContent();

    await pressShortcut(page, "c", { ctrlKey: true });
    await page.waitForTimeout(500);

    // Navigate back
    await page.keyboard.press("Control+Alt+ArrowLeft");
    await page.waitForTimeout(500);
    await waitForEntries(page);

    // Paste
    await pressShortcut(page, "v", { ctrlKey: true });
    await page.waitForTimeout(2000);

    // The pasted file should be selected
    const selectedEntries = await page.locator(".entry-item.selected .entry-name").allTextContents();
    expect(selectedEntries).toContain(fileName);
  });
});
