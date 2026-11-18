/**
 * E2E: custom min/max/close never render beside the macOS traffic lights (#1756).
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, seedSettings, waitForEntries } from "./helpers";

async function open(page: Page, platform: string, layoutTheme: string): Promise<void> {
  await page.addInitScript((value) => {
    Object.defineProperty(window.navigator, "platform", { get: () => value, configurable: true });
  }, platform);
  await seedSettings(page, { showWindowControls: true, integratedTitleBar: false, layoutTheme });
  await page.goto(HOME_URL);
  await waitForEntries(page);
}

for (const layoutTheme of ["default", "floating-islands"]) {
  test.describe(`window controls (${layoutTheme} layout)`, () => {
    test("macOS shows no custom controls even with the setting on", async ({ page }) => {
      await open(page, "MacIntel", layoutTheme);
      await expect(page.locator(".window-controls")).toHaveCount(0);
      await expect(page.locator(".control-btn")).toHaveCount(0);
    });

    test("non-Mac still shows the custom controls", async ({ page }) => {
      await open(page, "Linux x86_64", layoutTheme);
      await expect(page.locator(".window-controls")).toBeVisible();
      await expect(page.locator(".control-btn")).toHaveCount(3);
    });
  });
}

test("settings dialog omits Show Window Controls on macOS and lists it on Linux", async ({ page }) => {
  await open(page, "MacIntel", "default");
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await expect(page.getByText("Integrated Title Bar")).toBeVisible();
  await expect(page.getByText("Show Window Controls")).toHaveCount(0);

  await open(page, "Linux x86_64", "default");
  await page.keyboard.press("Control+,");
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await expect(page.getByText("Show Window Controls")).toBeVisible();
});
