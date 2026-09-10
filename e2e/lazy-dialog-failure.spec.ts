/**
 * Lazy-dialog chunk-load failure recovery (#584).
 *
 * Every dialog is code-split and imported on first open while its
 * dialogStore open-flag is already true. Before the fix, a failed chunk
 * import was silently swallowed: no dialog appeared and the stuck flag fed
 * dialogStore.hasModalOpen, blocking every global shortcut (a keyboard
 * soft-lock reported against "Switch Theme..." in the installed app).
 *
 * The Playwright route abort stands in for the real-world failure (stale
 * dist, dev-mode binary dialing a mismatched Vite server, offline asset
 * fetch).
 */
import { test, expect } from "./fixtures";
import { waitForEntries, HOME_URL } from "./helpers";

const THEME_PICKER_CHUNK = "**/ThemePicker.svelte*";

async function runSwitchThemeCommand(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Switch Theme");
  await page.keyboard.press("Enter");
}

test.describe("Lazy dialog chunk-load failure", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
  });

  test("failed Theme Picker chunk shows an error toast and keeps hotkeys alive", async ({ page }) => {
    await page.route(THEME_PICKER_CHUNK, (route) => route.abort());

    await runSwitchThemeCommand(page);

    // Recovery is user-visible: an error toast, no phantom modal.
    await expect(page.locator(".toast", { hasText: "Could not load Theme Picker" })).toBeVisible();
    await expect(page.locator(".theme-picker-dialog")).toHaveCount(0);

    // The open-flag was rolled back, so global shortcuts still work — the
    // pre-fix bug left hasModalOpen stuck true and this press did nothing.
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("reopening after a failed load fails safe again, never a soft-lock", async ({ page }) => {
    await page.route(THEME_PICKER_CHUNK, (route) => route.abort());
    await runSwitchThemeCommand(page);
    await expect(page.locator(".toast", { hasText: "Could not load Theme Picker" })).toBeVisible();
    await expect(page.locator(".toast", { hasText: "Could not load Theme Picker" })).toBeHidden();

    // The browser module map caches the failed import for the page's
    // lifetime, so an in-page retry cannot succeed even once the network
    // recovers — Chromium serves the cached rejection. The contract is that
    // EVERY attempt fails safe: toast again, flag rolled back, hotkeys alive.
    // Real recovery is the restart the toast asks for.
    await page.unroute(THEME_PICKER_CHUNK);
    await runSwitchThemeCommand(page);
    await expect(page.locator(".toast", { hasText: "Could not load Theme Picker" })).toBeVisible();
    await expect(page.locator(".theme-picker-dialog")).toHaveCount(0);

    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog")).toBeVisible();
  });

  test("a cancelled pending dialog cannot report failure over a different dialog", async ({ page }) => {
    let release!: () => void;
    let requested!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const request = new Promise<void>((resolve) => { requested = resolve; });
    await page.route(THEME_PICKER_CHUNK, async (route) => {
      requested();
      await held;
      await route.abort();
    });
    await runSwitchThemeCommand(page);
    await request;
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog")).toBeVisible();
    // Observe the real import failure before asserting the absence of feedback.
    const failed = page.waitForEvent("console", (message) =>
      message.type() === "error" && message.text().includes("Theme Picker dialog failed"));
    release();
    await failed;
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Snapshot after the failure's render turn. Retrying a negative assertion
    // would let the three-second toast expire and conceal the regression.
    expect(await page.locator(".toast", { hasText: "Could not load Theme Picker" }).count()).toBe(0);
    await page.locator(".quick-open-dialog input").fill("Documents");
    await expect(page.locator(".quick-open-dialog")).toContainText("Documents");
    await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/dialog-load-lifetime.png" });
  });
});
