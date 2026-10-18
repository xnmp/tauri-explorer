/**
 * A cropped image's thumbnail must be reloaded (#1267): the crop publishes an
 * invalidation of the path's cached thumbnails, whose keys are
 * `${kind}:${path}:${size}:${quality}`, and a mounted tile loads the new pixels.
 */
import { test, expect } from "./fixtures";
import { applySettingsAndReload, waitForEntries, runPaletteCommand } from "./helpers";

const tile = ".entry-item:has(.thumbnail-container)";

test("replacing an image with its crop refreshes the tile's thumbnail", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, { viewMode: "tiles" });
  await waitForEntries(page);
  const full = page.locator(tile, { hasText: "screenshot.png" }).locator(".thumbnail-full.loaded");
  await expect(full).toHaveCount(1, { timeout: 10_000 });
  const before = await full.getAttribute("src");

  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await runPaletteCommand(page, "Crop Image…");
  await page.getByRole("spinbutton", { name: "left pixel position" }).fill("32");
  await page.getByRole("button", { name: "Replace original…", exact: true }).click();
  await page.getByRole("button", { name: "Confirm replacement", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit image", exact: true })).toBeHidden();

  const refreshed = page.locator(tile, { hasText: "screenshot.png" }).locator(".thumbnail-full");
  await expect.poll(() => refreshed.getAttribute("src"), { timeout: 10_000 }).not.toBe(before);
  await expect(page.locator(tile, { hasText: "screenshot.png" }).locator(".thumbnail-full.loaded")).toHaveCount(1);
});
