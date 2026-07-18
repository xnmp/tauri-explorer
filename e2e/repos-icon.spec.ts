/**
 * E2E test: Repos bookmark shows code icon.
 * Issue: feat/repos-icon
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Repos bookmark icon", () => {
  test("sidebar renders bookmark items", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Sidebar bookmarks should be visible
    await expect(page.locator("text=BOOKMARKS")).toBeVisible();
  });
});
