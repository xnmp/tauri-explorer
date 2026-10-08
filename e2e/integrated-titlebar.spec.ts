/**
 * E2E test: integrated title bar setting.
 * Issue: feat/integrated-title-bar
 */
import { test, expect } from "./fixtures";
import { HOME_URL, applySettingsAndReload, waitForEntries } from "./helpers";

test.describe("Integrated title bar", () => {
  test("title bar row is always visible when integratedTitleBar is enabled", async ({ page }) => {
    // Pre-set the setting via localStorage before navigation
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { integratedTitleBar: true });
    await waitForEntries(page);

    // Tabs are per-pane (#140), so the integrated title bar is a standalone
    // drag-region row — it must render even with a single tab.
    await expect(page.locator(".titlebar")).toBeVisible();
  });

  test("tab bar is hidden with single tab when integratedTitleBar is disabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { integratedTitleBar: false, showWindowControls: false });
    await waitForEntries(page);

    // With both disabled and single tab, tab-area should not be visible
    const tabArea = page.locator(".tab-area");
    await expect(tabArea).not.toBeVisible();
  });
});
