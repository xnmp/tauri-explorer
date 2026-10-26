/**
 * Update notice (#185): when a newer release exists, a banner offers to open
 * the release page; the check is throttled to once per day.
 */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

// The check deliberately waits 5s after startup (UpdateNotice.svelte). The
// page clock jumps over that delay instead of sleeping through it (#1123).
const PAST_STARTUP_DELAY_MS = 6_000;

test("update notice appears when a newer release exists", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript((key) => localStorage.setItem(key, "1"), MOCK_LOCAL_KEYS.updateAvailable);
  await page.goto("/");
  await waitForEntries(page);

  const notice = page.locator('[data-testid="update-notice"]');
  await page.clock.runFor(PAST_STARTUP_DELAY_MS);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("9.9.9 is available");

  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).not.toBeVisible();
});

test("update check is throttled after a recent check", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript((key) => {
    localStorage.setItem(key, "1");
    localStorage.setItem("updateCheck.lastCheckedAt", String(Date.now()));
  }, MOCK_LOCAL_KEYS.updateAvailable);
  await page.goto("/");
  await waitForEntries(page);
  const lastChecked = await page.evaluate(() => localStorage.getItem("updateCheck.lastCheckedAt"));

  // Past the startup delay, a check would have re-stamped the last check time.
  await page.clock.runFor(PAST_STARTUP_DELAY_MS);
  await expect(page.locator('[data-testid="update-notice"]')).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("updateCheck.lastCheckedAt"))).toBe(lastChecked);
});
