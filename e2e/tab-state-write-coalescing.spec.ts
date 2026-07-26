/**
 * Tab-state persistence stays off the interaction path (#481).
 *
 * The unit suite proves the coalescing contract; this proves it holds in a
 * real browser driven by real key presses, where the burst timing is whatever
 * the input pipeline actually delivers rather than a fake clock. Counts the
 * `localStorage.setItem` calls that target the tab-state key during a burst
 * of Ctrl+T / Ctrl+Tab, and then checks the settled value still describes the
 * post-burst tab strip — coalescing must not cost the last interaction.
 */

import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

const TABS_KEY = "explorer-tabs";

test.beforeEach(async ({ page }) => {
  // Record every write before app code runs, so nothing escapes the count.
  await page.addInitScript(() => {
    const keys: string[] = [];
    (window as unknown as { __lsWrites: string[] }).__lsWrites = keys;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      keys.push(key);
      return original.call(this, key, value);
    };
  });
});

/** Writes recorded so far that targeted the tab-state key. */
function tabWriteCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(
    (key) =>
      (window as unknown as { __lsWrites: string[] }).__lsWrites.filter((k) => k === key).length,
    TABS_KEY,
  );
}

test("a burst of tab interactions coalesces into a handful of localStorage writes", async ({
  page,
}) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await expect(page.locator(".tab")).toHaveCount(1);

  // Ignore startup writes — only the interaction burst is under test.
  await page.evaluate(() => {
    (window as unknown as { __lsWrites: string[] }).__lsWrites.length = 0;
  });

  // 10 interactions: five new tabs, then five tab switches.
  for (let i = 0; i < 5; i++) await page.keyboard.press("Control+t");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Control+Tab");
  await expect(page.locator(".tab")).toHaveCount(6);

  // Before the fix this was 10 — one flush stall per key press. The bound is
  // 3, not 1, only because a real input pipeline can leave a gap longer than
  // the coalescing window between presses; the pre-fix count cannot get near
  // it, since pre-fix every single interaction wrote.
  expect(await tabWriteCount(page)).toBeLessThanOrEqual(3);

  // The coalesced write is not a dropped write: what a next boot reads back
  // still describes the strip the user ended up with.
  await expect
    .poll(async () =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as { tabs: unknown[] }).tabs.length : 0;
      }, TABS_KEY),
    )
    .toBe(6);
});
