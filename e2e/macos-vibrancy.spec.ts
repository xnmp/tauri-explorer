/**
 * E2E test: macOS vibrancy setting.
 * Issue: feat/macos-vibrancy
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("macOS vibrancy", () => {
  test("data-vibrancy attribute is set when macOsVibrancy is enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await page.evaluate(() => {
      const stored = localStorage.getItem("explorer-settings");
      const settings = stored ? JSON.parse(stored) : {};
      settings.macOsVibrancy = true;
      localStorage.setItem("explorer-settings", JSON.stringify(settings));
    });
    await page.reload();
    await waitForEntries(page);

    const hasAttr = await page.evaluate(() =>
      document.documentElement.hasAttribute("data-vibrancy")
    );
    expect(hasAttr).toBe(true);
  });

  test("data-vibrancy attribute is absent when macOsVibrancy is disabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await page.evaluate(() => {
      const stored = localStorage.getItem("explorer-settings");
      const settings = stored ? JSON.parse(stored) : {};
      settings.macOsVibrancy = false;
      localStorage.setItem("explorer-settings", JSON.stringify(settings));
    });
    await page.reload();
    await waitForEntries(page);

    const hasAttr = await page.evaluate(() =>
      document.documentElement.hasAttribute("data-vibrancy")
    );
    expect(hasAttr).toBe(false);
  });

  test("vibrancy CSS makes body transparent when enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await page.evaluate(() => {
      const stored = localStorage.getItem("explorer-settings");
      const settings = stored ? JSON.parse(stored) : {};
      settings.macOsVibrancy = true;
      localStorage.setItem("explorer-settings", JSON.stringify(settings));
    });
    await page.reload();
    await waitForEntries(page);

    const bodyBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );
    expect(bodyBg).toBe("rgba(0, 0, 0, 0)");
  });
});
