/**
 * Screenshot capture for #144: the Nano Banana context-menu entry is present
 * when the plugin is enabled and absent when disabled. Not a behavioral
 * assertion (that lives in nano-banana.spec.ts) — this exists to produce the
 * issue's required before/after images. Run with:
 *   bunx playwright test e2e/nano-banana-screenshot.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import { waitForEntries, HOME_URL, pressShortcut } from "./helpers";
import { mkdirSync } from "node:fs";

const DIR = "screenshots/feat/plugin-nano-banana";

/** Toggle the nano-banana plugin through the real Settings UI (same path the
 *  behavioral spec uses — a plugin's enabled state lives in the plugins map,
 *  not a top-level settings key, so this is the reliable way to flip it). */
async function setNanoBananaEnabled(page: Page, enabled: boolean) {
  await pressShortcut(page, ",", { ctrlKey: true });
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const row = dialog.locator('.setting-row:has-text("Nano Banana")').first();
  const toggle = row.locator('input[type="checkbox"]').first();
  if ((await toggle.isChecked()) !== enabled) {
    await row.locator("label.toggle").click();
  }
  await expect(toggle).toBeChecked({ checked: enabled });
  await dialog.locator(".close-btn").click();
  await expect(dialog).toBeHidden();
}

async function rightClickImage(page: Page) {
  const image = page.locator(".entry-item").filter({ hasText: "photo1.jpg" }).first();
  await image.click();
  await image.click({ button: "right" });
  await page.locator(".context-menu").waitFor({ state: "visible", timeout: 3000 });
}

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

test.beforeEach(async ({ page }) => {
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
});

test("context menu shows Nano Banana entry when plugin enabled", async ({ page }) => {
  await rightClickImage(page);
  await expect(
    page.locator('.context-menu .menu-item:has-text("Edit with Nano Banana")')
  ).toBeVisible();
  await page.locator(".context-menu").screenshot({
    path: `${DIR}/context-menu-plugin-enabled.png`,
  });
});

test("context menu omits Nano Banana entry when plugin disabled", async ({ page }) => {
  await setNanoBananaEnabled(page, false);
  await rightClickImage(page);
  // Assert the entry is genuinely gone before capturing the "after" image.
  await expect(
    page.locator('.context-menu .menu-item:has-text("Edit with Nano Banana")')
  ).toHaveCount(0);
  await page.locator(".context-menu").screenshot({
    path: `${DIR}/context-menu-plugin-disabled.png`,
  });
});
