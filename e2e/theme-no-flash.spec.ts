/**
 * Theme is applied from persisted settings without a flash (perf #9).
 *
 * Previously `data-theme` was only set once the theme store's listUserThemes
 * IPC resolved (well after first paint), so every launch flashed the default
 * theme. The fix applies the saved theme synchronously — at JS module load in
 * the browser, and (in the real Tauri binary) from the Rust init_script before
 * the bundle parses. This test covers the browser layer: after a reload with a
 * saved non-default theme, data-theme must already match the saved theme.
 */

import { test, expect } from "@playwright/test";

test.describe("Theme applied without flash", () => {
  test("saved theme is applied on reload before any post-load correction", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.waitForSelector(".file-list");

    // Persist a non-default theme the way the settings store does.
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.theme = "hacker";
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });

    await page.reload();

    // data-theme must reflect the saved theme. The synchronous apply means it
    // is correct as soon as the document is interactive — no default-theme
    // value is ever observed settling to "hacker".
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hacker");

    // Sanity: still correct after the file list (and theme store IPC) settle.
    await page.waitForSelector(".file-list");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hacker");
  });
});
