/**
 * Duplicate theme ids must not crash the theme picker (#585).
 *
 * A user theme in ~/.config/tauri-explorer/themes/ that reuses a built-in id
 * (the installed-app report: a custom nord.css) used to produce two entries
 * with the same id in themeStore.availableThemes; ThemePicker's keyed each
 * then threw each_key_duplicate mid-mount, and the stuck dialog open-flag
 * soft-locked every shortcut. discoverThemes now dedupes by id, last wins.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, HOME_URL } from "./helpers";

test.describe("Theme picker with a duplicated theme id", () => {
  test.beforeEach(async ({ page }) => {
    // Two rules sharing one data-theme id, both carrying --theme-name —
    // exactly what a user theme colliding with a built-in produces. Injected
    // at document_start so the sheet exists before initTheme() discovery.
    await page.addInitScript(() => {
      // DOMContentLoaded + head: an element appended at document_start gets
      // discarded before the app boots (verified), this timing survives and
      // still precedes initTheme()'s discovery pass in onMount.
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = `
          [data-theme="dup-test"] { --theme-name: "Dup First"; --background-solid: #111111; --divider: #222222; --accent: #333333; }
          [data-theme="dup-test"] { --theme-name: "Dup Override"; --background-solid: #111111; --divider: #222222; --accent: #333333; }
        `;
        document.head.appendChild(style);
      });
    });
    await page.goto(HOME_URL);
    await waitForEntries(page);
  });

  test("picker opens, lists the id once with the last definition winning", async ({ page }) => {
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Switch Theme");
    await page.keyboard.press("Enter");

    // Pre-fix this crashed mid-mount (each_key_duplicate) and never appeared.
    await expect(page.locator(".theme-picker-dialog")).toBeVisible();

    await page.locator(".theme-picker-dialog .search-input").fill("Dup");
    const entries = page.locator(".theme-picker-dialog").getByText(/^Dup /);
    await expect(entries).toHaveCount(1);
    await expect(entries).toHaveText("Dup Override");

    // No soft-lock: close, then a global shortcut still works.
    await page.keyboard.press("Escape");
    await expect(page.locator(".theme-picker-dialog")).toBeHidden();
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog")).toBeVisible();
  });
});
