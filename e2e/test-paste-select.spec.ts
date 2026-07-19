/**
 * E2E test for paste-select feature (tauri-explorer-zktf)
 * Verifies that pasted files are selected after paste completes.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Paste selects pasted files", () => {
  test("cross-dir paste selects the pasted file", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    // Navigate into Documents
    const docsDir = page.locator(".entry-item", { hasText: "Documents" }).first();
    await docsDir.dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText("Documents");
    await waitForEntries(page);

    // Copy a file
    const file = page.locator(".entry-item:not(.directory)").first();
    await file.click();
    await expect(file).toHaveClass(/selected/);
    const fileName = await file.locator(".entry-name").textContent();

    await pressShortcut(page, "c", { ctrlKey: true });
    await expect(page.locator(".toast.clipboard")).toBeVisible();

    // Navigate back
    await page.keyboard.press("Control+Alt+ArrowLeft");
    await expect(page.locator(".breadcrumbs-container")).not.toContainText("Documents");
    await waitForEntries(page);

    // Paste — the pasted file should end up selected
    await pressShortcut(page, "v", { ctrlKey: true });
    await expect
      .poll(() => page.locator(".entry-item.selected .entry-name").allTextContents(), {
        timeout: 5000,
      })
      .toContain(fileName);
  });
});
