/**
 * E2E test: pasting a file into its own parent folder creates a copy
 * ("name - Copy.ext") instead of prompting a conflict or no-op.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Same-folder paste makes a copy", () => {
  test("copy + paste in the same directory yields a ' - Copy' file", async ({ page }) => {
    await page.goto("http://localhost:1420/?path=/home/user");
    await waitForEntries(page);

    // Select a file and copy it
    const file = page.locator(".entry-item", { hasText: "readme.txt" }).first();
    await file.click();
    await expect(file).toHaveClass(/selected/);

    await pressShortcut(page, "c", { ctrlKey: true });
    await expect(page.locator(".toast.clipboard")).toBeVisible();

    // Paste into the SAME folder — no conflict dialog should appear, and a
    // copy named "readme - Copy.txt" should be created.
    await pressShortcut(page, "v", { ctrlKey: true });

    await expect
      .poll(() => page.locator(".entry-item .entry-name").allTextContents(), {
        timeout: 5000,
      })
      .toContain("readme - Copy.txt");

    // The original is still there, and no conflict dialog interrupted the paste.
    await expect(page.locator(".entry-item", { hasText: "readme.txt" }).first()).toBeVisible();
    await expect(page.locator(".conflict-dialog")).toHaveCount(0);
  });
});
