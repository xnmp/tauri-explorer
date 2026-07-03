/**
 * E2E tests for the embedded terminal panel (issue #139) — browser/mock mode.
 *
 * A real PTY needs the Tauri binary (covered by e2e-tauri/terminal.spec.ts);
 * here we assert the panel chrome behavior: Ctrl+` toggling, xterm mounting,
 * theme-following background, and height persistence.
 */

import { test, expect } from "@playwright/test";
import { waitForEntries, HOME_URL } from "./helpers";

test.describe("Terminal panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME_URL);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);
  });

  test("Ctrl+` opens the panel with a live xterm instance and toggles it closed", async ({ page }) => {
    await expect(page.locator(".terminal-panel")).toHaveCount(0);

    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible({ timeout: 5000 });
    // xterm actually mounted (renders its accessibility textarea + screen).
    await expect(panel.locator(".xterm")).toBeVisible();
    await expect(panel.locator("textarea.xterm-helper-textarea")).toBeAttached();

    // Toggle closed: panel hides but stays mounted (shell session survives).
    await page.keyboard.press("Control+`");
    await expect(panel).toBeHidden();
    await expect(panel).toBeAttached();

    // And back open.
    await page.keyboard.press("Control+`");
    await expect(panel).toBeVisible();
  });

  test("panel background follows the app theme", async ({ page }) => {
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();

    const readBg = () => panel.evaluate((el) => getComputedStyle(el).backgroundColor);
    const initialBg = await readBg();

    // Switch theme via the settings store (same code path as the theme picker).
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await expect.poll(readBg).not.toBe(initialBg);

    // The terminal panel's background is the theme's solid background.
    const solid = await panel.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--background-solid").trim()
    );
    expect(solid).not.toBe("");
  });

  test("cwd-sync toggles appear in Settings and default to ON", async ({ page }) => {
    await page.keyboard.press("Control+,");
    const dialog = page.locator(".settings-dialog");
    await dialog.waitFor({ state: "visible", timeout: 2000 });

    for (const label of ["Terminal Follows Explorer", "Explorer Follows Terminal"]) {
      const row = dialog.locator(".setting-row", { hasText: label });
      await expect(row).toBeVisible();
      // Both default TRUE (bidirectional sync on out of the box).
      await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    }
  });

  test("close button hides the panel", async ({ page }) => {
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();

    // The header has no manual sync-to-folder button — cwd sync is automatic
    // (issue #149), so the only action is Hide.
    await panel.locator('[aria-label="Hide terminal"]').click();
    await expect(panel).toBeHidden();
  });
});
