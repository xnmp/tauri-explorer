/**
 * An unhandled promise rejection is not a crash (#1056).
 *
 * The app keeps running after a rejection, so it is logged but never recorded
 * as a crash file — otherwise every launch after one claims "crashed last
 * time". A real uncaught error still is (crash-notice.spec.ts).
 */

import { test, expect } from "./fixtures";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

test("a launch after an unhandled rejection shows no crash notice", async ({ page }) => {
  await page.goto("/");
  // Handlers install with the app; rejecting earlier would go unobserved.
  await page.waitForSelector(".file-list");

  await page.evaluate(() => {
    void Promise.reject(new TypeError("undefined is not an object (evaluating 'e.startsWith')"));
  });
  // Give the unhandledrejection handler time to run; a recorded crash would
  // land in the mock's crash slot by now.
  await page.waitForTimeout(500);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), MOCK_LOCAL_KEYS.frontendCrash),
  ).toBeNull();

  // Next launch: clean, no "crashed last time" banner.
  await page.reload();
  await page.waitForSelector(".file-list");
  await expect(page.locator('[data-testid="crash-notice"]')).not.toBeVisible();
  await page.screenshot({ path: "evidence/ac-5-clean-launch-no-crash-notice.png" });
});
