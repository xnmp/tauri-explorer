/**
 * Update notice (#185): when a newer release exists, a banner offers to open
 * the release page; the check is throttled to once per day.
 */

import { test, expect } from "./fixtures";

test("update notice appears when a newer release exists", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mockUpdateAvailable", "1"));
  await page.goto("/");

  // The check deliberately waits ~5s after startup.
  const notice = page.locator('[data-testid="update-notice"]');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("9.9.9 is available");
  await page.screenshot({ path: "evidence/ac-2-dialog-controls.png" });

  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).not.toBeVisible();
});

test("View release opens the update URL and dismisses the notice", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mockUpdateAvailable", "1"));
  await page.goto("/");

  const notice = page.locator('[data-testid="update-notice"]');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await notice.getByRole("button", { name: "View release" }).click();
  await expect(notice).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url"))).toBe(
    "https://github.com/xnmp/tauri-explorer/releases/tag/v9.9.9",
  );
  await page.screenshot({ path: "evidence/ac-3-update-actions.png" });
});

test("update notice uses themed shared dialog controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mockUpdateAvailable", "1");
    localStorage.setItem("theme", JSON.stringify("dark"));
  });
  await page.goto("/");

  const notice = page.locator('[data-testid="update-notice"]');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(notice).toHaveClass(/modal-card/);
  await expect(notice).toHaveCSS("border-radius", "16px");
  await expect(notice).toHaveCSS("background-color", "rgba(38, 38, 40, 0.92)");
  await expect(notice.getByRole("button", { name: "View release" })).toHaveClass(/btn primary/);
  await expect(notice.getByRole("button", { name: "Dismiss" })).toHaveClass(/btn secondary/);
  await page.screenshot({ path: "evidence/ac-1-themed-update-notice.png" });
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
