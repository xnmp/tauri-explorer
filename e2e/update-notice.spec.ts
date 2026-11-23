/**
 * Update notice (#185): when a newer release exists, a banner offers to open
 * the release page; the check is throttled to once per day.
 */

import { test, expect } from "./fixtures";
import { runPaletteCommand, waitForEntries } from "./helpers";
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

// #1901: the palette runs the check on demand, even inside the daily throttle,
// and reports the outcome instead of staying silent.
test("Check for Updates in the palette bypasses the daily throttle", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "1");
    localStorage.setItem("updateCheck.lastCheckedAt", String(Date.now()));
  }, MOCK_LOCAL_KEYS.updateAvailable);
  await page.goto("/");
  await waitForEntries(page);

  await runPaletteCommand(page, "Check for Updates");
  const notice = page.locator('[data-testid="update-notice"]');
  await expect(notice).toContainText("9.9.9 is available");

  // Dismissing and asking again offers the release again.
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).not.toBeVisible();
  await runPaletteCommand(page, "Check for Updates");
  await expect(notice).toContainText("9.9.9 is available");
});

test("Check for Updates reports when the app is up to date", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("updateCheck.lastCheckedAt", String(Date.now())));
  await page.goto("/");
  await waitForEntries(page);

  await runPaletteCommand(page, "Check for Updates");
  await expect(page.getByText("Tauri Explorer is up to date")).toBeVisible();
  await expect(page.locator('[data-testid="update-notice"]')).not.toBeVisible();
});
