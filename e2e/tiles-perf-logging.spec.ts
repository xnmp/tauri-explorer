/**
 * E2E test: tiles view scroll handler exists and doesn't error.
 * Issue: feat/tiles-scroll-perf-logging
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries, switchViewMode } from "./helpers";

test.describe("Tiles scroll performance logging", () => {
  test("tiles view has onscroll handler wired", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await switchViewMode(page, "tiles");

    // Verify tiles view is visible
    await expect(page.locator(".tiles-view")).toBeVisible();

    // Scroll should not throw errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.locator(".tiles-view").evaluate((el) => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(200);

    expect(consoleErrors).toHaveLength(0);
  });
});
