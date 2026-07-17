/**
 * E2E test: miller column entries are draggable (via HTML5 on non-Mac,
 * pointer-based on Mac where draggable is intentionally false).
 * Issue: feat/miller-to-bookmarks
 */
import { test, expect } from "./fixtures";

test.describe("Miller columns drag to bookmarks", () => {
  test("miller column entries have draggable attribute on non-Mac", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await page.waitForSelector(".entry-item", { timeout: 5000 });

    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 1;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });
    await page.waitForSelector(".entry-item", { timeout: 5000 });
    await page.waitForTimeout(500);

    const entry = page.locator(".col-entry").first();
    const isMac = await page.evaluate(() => navigator.platform.startsWith("Mac"));

    // On macOS, draggable is false (uses pointer-based drag instead of HTML5 DnD)
    const expected = isMac ? "false" : "true";
    await expect(entry).toHaveAttribute("draggable", expected);
  });
});
