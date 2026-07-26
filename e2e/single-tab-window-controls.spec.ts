/**
 * E2E: the tab title must stay visible with a single tab when native window
 * controls are enabled (#504).
 *
 * The title bar row already renders to host the min/max/close buttons, so
 * hiding the lone tab saves no vertical space — it just leaves the user's
 * current folder unlabelled. This asserts at the rendered-DOM seam rather
 * than on the visibility helper, so a component that forgets to feed the
 * setting through still fails.
 *
 * Regression guard: this was fixed once inline in WindowTabBar.svelte
 * (5ca49d76) and lost when #140 extracted the rules into domain/titlebar.ts.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

/** Persist the chrome settings before first paint, so the app renders the
 *  configuration under test on its very first render (no toggle flicker). */
const setChrome = (page: Page, showWindowControls: boolean) =>
  page.addInitScript((controls) => {
    const key = "explorer-settings";
    const settings = JSON.parse(localStorage.getItem(key) || "{}");
    settings.showWindowControls = controls;
    // Keep the macOS integrated title bar out of it: it renders the row for
    // its own reasons and would mask what this test is checking.
    settings.integratedTitleBar = false;
    localStorage.setItem(key, JSON.stringify(settings));
  }, showWindowControls);

/** Tabs are per-pane (#140); Ctrl+T opens a second one. */
const openSecondTab = async (page: Page) => {
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
};

test.describe("Single tab with native window controls (#504)", () => {
  test("shows the tab title with one tab when window controls are enabled", async ({ page }) => {
    await setChrome(page, true);
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // The configuration under test: exactly one tab, controls rendered.
    await expect(page.locator(".tab")).toHaveCount(1);
    await expect(page.locator(".window-controls")).toBeVisible();

    // AC 1 — the strip renders and the title names the current folder.
    await expect(page.locator(".tab-area")).toBeVisible();
    await expect(page.locator(".tab-title")).toBeVisible();
    await expect(page.locator(".tab-cwd")).toHaveText("user");

    await page.screenshot({ path: "evidence/ac-1-single-tab-title-with-controls.png" });
  });

  test("still hides the strip with one tab when window controls are disabled", async ({ page }) => {
    await setChrome(page, false);
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // AC 2 — the chrome-less layout (tiling WMs) is unchanged: no strip at all.
    await expect(page.locator(".tab-area")).not.toBeVisible();
    await expect(page.locator(".window-controls")).not.toBeVisible();

    await page.screenshot({ path: "evidence/ac-2-no-strip-without-controls.png" });
  });

  test("keeps every tab title visible with two tabs and window controls enabled", async ({ page }) => {
    await setChrome(page, true);
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await openSecondTab(page);

    // AC 3 — multi-tab behaviour is untouched by the single-tab rule.
    await expect(page.locator(".tab-area")).toBeVisible();
    const titles = page.locator(".tab-title");
    await expect(titles).toHaveCount(2);
    await expect(titles.first()).toBeVisible();
    await expect(titles.last()).toBeVisible();

    await page.screenshot({ path: "evidence/ac-3-two-tabs-titles-visible.png" });
  });

  test("keeps two tabs visible when window controls are disabled", async ({ page }) => {
    await setChrome(page, false);
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await openSecondTab(page);

    // The other half of AC 3: multi-tab visibility must not become dependent
    // on the window-controls setting.
    await expect(page.locator(".tab-area")).toBeVisible();
    await expect(page.locator(".tab-title")).toHaveCount(2);
  });
});
