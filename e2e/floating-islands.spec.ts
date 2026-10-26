/**
 * Floating Islands layout on any platform (#277, #1306).
 *
 * Selecting the Floating Islands layout must apply the island arrangement
 * without any native backdrop: the layout base attribute is set, the native
 * backdrop capability is not, and the sidebar renders as a rounded island
 * over an opaque window.
 */
import { test, expect } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";

test.describe("Floating islands (#277)", () => {
  test("selecting the layout applies islands without a native backdrop", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    await applySettingsAndReload(page, { layoutTheme: "floating-islands" });
    await waitForEntries(page);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-layout-base", "floating-islands");
    await expect(html).not.toHaveAttribute("data-native-backdrop");

    // The sidebar renders as a rounded island (non-zero radius) over an
    // opaque body: without native material nothing may be see-through.
    const radius = await page
      .locator(".sidebar-container")
      .evaluate((el) => getComputedStyle(el).borderRadius);
    expect(parseFloat(radius)).toBeGreaterThan(0);
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).not.toBe("rgba(0, 0, 0, 0)");

    await applySettingsAndReload(page, { layoutTheme: "default" });
    await waitForEntries(page);
    await expect(html).toHaveAttribute("data-layout-base", "default");
    const flatRadius = await page
      .locator(".sidebar-container")
      .evaluate((el) => getComputedStyle(el).borderRadius);
    expect(parseFloat(flatRadius)).toBe(0);
  });
});
