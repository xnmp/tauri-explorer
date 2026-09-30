/**
 * E2E test: macOS vibrancy setting.
 * Issue: feat/macos-vibrancy
 */
import { test, expect } from "./fixtures";
import { HOME_URL, applySettingsAndReload, waitForEntries } from "./helpers";

test.describe("macOS vibrancy", () => {
  test("data-vibrancy attribute is set when macOsVibrancy is enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: true });
    await waitForEntries(page);

    const hasAttr = await page.evaluate(() =>
      document.documentElement.hasAttribute("data-vibrancy")
    );
    expect(hasAttr).toBe(true);
  });

  test("data-vibrancy attribute is absent when macOsVibrancy is disabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: false });
    await waitForEntries(page);

    const hasAttr = await page.evaluate(() =>
      document.documentElement.hasAttribute("data-vibrancy")
    );
    expect(hasAttr).toBe(false);
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
});
