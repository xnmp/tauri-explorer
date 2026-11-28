/**
 * A file whose contents changed shows its new thumbnail without a restart
 * (#1937). Thumbnail cache keys carry the entry's content version (mtime and
 * size), so a refreshed listing with a new version asks the backend again
 * instead of reusing the cached blob URL.
 */
import { test, expect } from "./fixtures";
import type { MockControl } from "../src/lib/api/mock-control";
import { applySettingsAndReload, waitForEntries } from "./helpers";

const TARGET = "/home/user/Pictures/screenshot.png";
const tile = ".entry-item:has(.thumbnail-container)";
type Win = { __mockControl?: MockControl };

test("an image edited outside the app shows its new thumbnail after the listing refreshes", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, { viewMode: "tiles" });
  await waitForEntries(page);
  const full = page.locator(tile, { hasText: "screenshot.png" }).locator(".thumbnail-full.loaded");
  await expect(full).toHaveCount(1, { timeout: 10_000 });
  const before = await full.getAttribute("src");

  await page.evaluate((target) => {
    const control = ((window as unknown as Win).__mockControl ??= {});
    control.invokeArgs = { get_thumbnail_data: [] };
    control.previewRevision?.(target);
  }, TARGET);
  await page.keyboard.press("F5");
  await waitForEntries(page);

  const requested = () => page.evaluate((target) =>
    ((window as unknown as Win).__mockControl?.invokeArgs?.get_thumbnail_data ?? []).filter((args) => args.path === target).length, TARGET);
  await expect.poll(requested, { timeout: 10_000 }).toBeGreaterThan(0);
  const refreshed = page.locator(tile, { hasText: "screenshot.png" }).locator(".thumbnail-full");
  await expect.poll(() => refreshed.getAttribute("src"), { timeout: 10_000 }).not.toBe(before);
  await expect(page.locator(tile, { hasText: "screenshot.png" }).locator(".thumbnail-full.loaded")).toHaveCount(1);
  await page.screenshot({ path: "screenshots/fix/thumbnail-refresh-on-update/thumbnail-after-edit.png" });
});
