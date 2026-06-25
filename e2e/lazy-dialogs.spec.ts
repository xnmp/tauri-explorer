/**
 * Lazy-loaded overlay dialogs open on demand (cold-start optimization).
 *
 * SettingsDialog, ContentSearchDialog, QuickOpen, CommandPalette and FilePicker
 * are dynamically imported via `{#if open}{#await import(...)}` in +page.svelte,
 * keeping them out of the initial bundle. This guards the contract that each
 * still opens (the dynamic import resolves and renders) and closes cleanly —
 * a broken lazy import would leave the trigger doing nothing.
 *
 * FilePicker is covered separately (e2e/file-picker.spec.ts) since it requires
 * a ?picker= URL param rather than an in-app trigger.
 */

import { test, expect } from "@playwright/test";

test.describe("Lazy-loaded dialogs open on demand", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.waitForSelector(".file-list");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  });

  test("Quick Open (Ctrl+P) lazy-loads and opens", async ({ page }) => {
    const dialog = page.locator(".quick-open-dialog");
    await expect(dialog).toHaveCount(0); // not in DOM until opened
    await page.keyboard.press("Control+p");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Command Palette (Ctrl+Shift+P) lazy-loads and opens", async ({ page }) => {
    const dialog = page.locator(".command-palette-dialog");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Control+Shift+p");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Content Search (Ctrl+Shift+F) lazy-loads and opens", async ({ page }) => {
    await page.keyboard.press("Control+Shift+f");
    // The content search dialog renders an input; assert it appears.
    const dialog = page.locator(".content-search-dialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Settings dialog lazy-loads and opens", async ({ page }) => {
    await page.keyboard.press("Control+,");
    const dialog = page.locator(".settings-dialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
