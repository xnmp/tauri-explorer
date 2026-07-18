/**
 * Crash notice (#184): after a crash, the next launch shows a banner offering
 * to report the saved crash on GitHub, exactly once.
 */

import { test, expect } from "./fixtures";

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

test("a frontend error is recorded and offered as a crash on next launch", async ({ page }) => {
  await page.goto("/");
  // goto resolves before any app JS runs under Vite dev, so wait until the
  // app is interactive — dispatching earlier races handler installation and
  // the error would go unrecorded.
  await page.waitForSelector(".file-list");

  // Trigger an uncaught error the global handler captures + records.
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", { message: "synthetic frontend boom", filename: "app.js" }),
    );
  });

  // record_frontend_crash persists the record for the next launch.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mockFrontendCrash")))
    .not.toBeNull();

  // Next launch: the notice offers the frontend crash exactly like a Rust one.
  await page.reload();
  const notice = page.locator('[data-testid="crash-notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("crashed last time");
  await expect(notice).toContainText("nothing was sent anywhere");

  // Consumed on read: a further reload must not re-offer the same crash.
  await page.reload();
  await expect(page.locator('[data-testid="crash-notice"]')).not.toBeVisible();
});
