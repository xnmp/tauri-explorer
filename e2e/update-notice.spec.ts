/**
 * Update notice (#185): when a newer release exists, a banner offers to open
 * the release page; the check is throttled to once per day.
 */

import { test, expect } from "@playwright/test";

test("update notice appears when a newer release exists", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mockUpdateAvailable", "1"));
  await page.goto("/");

  // The check deliberately waits ~5s after startup.
  const notice = page.locator('[data-testid="update-notice"]');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("9.9.9 is available");

  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).not.toBeVisible();
});

test("update check is throttled after a recent check", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mockUpdateAvailable", "1");
    localStorage.setItem("updateCheck.lastCheckedAt", String(Date.now()));
  });
  await page.goto("/");

  // Give the startup-delay window time to elapse, then assert no check ran.
  await page.waitForTimeout(7000);
  await expect(page.locator('[data-testid="update-notice"]')).not.toBeVisible();
});
