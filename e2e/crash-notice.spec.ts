/**
 * Crash notice (#184): after a crash, the next launch shows a banner offering
 * to report the saved crash on GitHub, exactly once.
 */

import { test, expect } from "@playwright/test";

test("crash notice appears after a crash and dismisses", async ({ page }) => {
  // Seed the flag, then reload — addInitScript would re-seed it on every
  // navigation and defeat the consumed-on-read assertion below.
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("mockCrashReport", "1"));
  await page.reload();

  const notice = page.locator('[data-testid="crash-notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("crashed last time");
  await expect(notice).toContainText("crash-1700000000.txt");
  await expect(notice).toContainText("nothing was sent anywhere");

  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).not.toBeVisible();

  // Consumed on read: a reload must not offer the same crash again.
  await page.reload();
  await expect(page.locator('[data-testid="crash-notice"]')).not.toBeVisible();
});

test("no crash notice on a clean launch", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="crash-notice"]')).not.toBeVisible();
});
