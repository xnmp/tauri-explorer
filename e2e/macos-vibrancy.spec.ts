/**
 * E2E test: macOS vibrancy setting.
 * Issue: feat/macos-vibrancy, #1306 (native backdrop is independent of layout)
 */
import { test, expect } from "./fixtures";
import { HOME_URL, applySettingsAndReload, waitForEntries } from "./helpers";

test.describe("macOS vibrancy", () => {
  test("data-native-backdrop is set when macOsVibrancy is enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: true });
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-native-backdrop", "");
  });

  test("data-native-backdrop is absent when macOsVibrancy is disabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: false });
    await waitForEntries(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-native-backdrop");
  });

  test("vibrancy CSS makes body transparent when enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: true });
    await waitForEntries(page);

    const bodyBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );
    expect(bodyBg).toBe("rgba(0, 0, 0, 0)");
  });

  test("native backdrop works under every layout, including Default", async ({ page }) => {
    await page.goto(HOME_URL);
    for (const layoutTheme of ["default", "floating-islands", "hairline-ledger"]) {
      await applySettingsAndReload(page, { macOsVibrancy: true, layoutTheme });
      await waitForEntries(page);
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-layout", layoutTheme);
      await expect(html).toHaveAttribute("data-native-backdrop", "");
      // Transparency is the window's, not the layout's: the body stays clear.
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    }
  });
});
