/**
 * E2E test: file icons show extension labels for code/document files.
 * Issue: feat/more-file-icons
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("File type icons", () => {
  test("file list renders file icons", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Verify file icons are rendered
    const icons = page.locator(".icon svg, .icon .nf-icon");
    await expect(icons.first()).toBeVisible();
  });
});
