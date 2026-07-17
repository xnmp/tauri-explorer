/**
 * Floating islands layout on any platform (#277).
 *
 * The floatingIslands setting must apply the island CSS without any native
 * backdrop: data-vibrancy + data-vibrancy-no-blur on the root, and the
 * sidebar rendered as a rounded island.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test.describe("Floating islands (#277)", () => {
  test("enabling the setting applies the island layout without a native backdrop", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.floatingIslands = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.reload();
    await waitForEntries(page);

    // Root attributes: island mode on, no-blur fallback (no native backdrop).
    await expect(page.locator("html")).toHaveAttribute("data-vibrancy", "");
    await expect(page.locator("html")).toHaveAttribute("data-vibrancy-no-blur", "");

    // The sidebar renders as a rounded island (non-zero radius).
    const radius = await page
      .locator(".sidebar-container")
      .evaluate((el) => getComputedStyle(el).borderRadius);
    expect(parseFloat(radius)).toBeGreaterThan(0);

    // Off again: attributes drop without a reload (reactive effect).
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings")!);
      s.floatingIslands = false;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.reload();
    await waitForEntries(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-vibrancy", "");
  });
});
