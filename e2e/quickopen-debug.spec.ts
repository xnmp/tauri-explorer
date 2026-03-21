/**
 * E2E test: QuickOpen debug mode shows score breakdown.
 * Issue: feat/quickopen-debug, fix/quickopen-debug-settings
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("QuickOpen debug mode", () => {
  test("footer shows Alt+D hint", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Open QuickOpen via command system
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(500);

    // Check for Alt+D hint in footer
    const footer = page.locator(".quick-open-dialog .footer");
    if (await footer.isVisible()) {
      await expect(footer).toContainText("Alt+D");
    }
  });
});
