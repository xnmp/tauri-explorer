/**
 * Thumbnail cache behavior (#247, #248).
 *
 * Loaded thumbnails must survive layout shifts (preview open/close,
 * fullscreen exit) without flashing back to the SVG placeholder, and a
 * duplicated tab must paint its tiles from the shared LRU cache instead of
 * re-running the placeholder → load cycle.
 */
import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

async function openPicturesTiles(page: import("@playwright/test").Page) {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Tiles View");
  await page.keyboard.press("Enter");
  // Image thumbnails resolved (micro + full per image file).
  await expect
    .poll(() => page.locator(".thumbnail-container img").count())
    .toBeGreaterThan(0);
}

test.describe("Thumbnail cache", () => {
  test("loaded thumbnails survive preview open/close without placeholder flashes (#247)", async ({ page }) => {
    await openPicturesTiles(page);
    const imgCount = await page.locator(".thumbnail-container img").count();

    // Track any placeholder re-appearance inside the file list.
    await page.evaluate(() => {
      (window as unknown as { __phFlashes: number }).__phFlashes = 0;
      const list = document.querySelector(".file-list")!;
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            const el = n as Element;
            if (el.nodeType === 1 && (el.matches?.(".thumbnail-placeholder") || el.querySelector?.(".thumbnail-placeholder"))) {
              (window as unknown as { __phFlashes: number }).__phFlashes++;
            }
          }
        }
      }).observe(list, { subtree: true, childList: true });
    });

    // Preview pane open/close resizes the list; fullscreen exit toggles the
    // titlebar. Neither may flash placeholders over loaded thumbnails.
    await page.getByText("photo1.jpg", { exact: true }).first().click();
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await page.evaluate(async () => {
      document.documentElement.setAttribute("data-preview-fullscreen", "");
      await new Promise((r) => setTimeout(r, 100));
      document.documentElement.removeAttribute("data-preview-fullscreen");
      await new Promise((r) => setTimeout(r, 100));
    });

    const flashes = await page.evaluate(() => (window as unknown as { __phFlashes: number }).__phFlashes);
    expect(flashes).toBe(0);
    await expect(page.locator(".thumbnail-container img")).toHaveCount(imgCount);
  });

  test("a duplicated tab paints tiles from the cache, not placeholders (#248)", async ({ page }) => {
    await openPicturesTiles(page);
    const imgCount = await page.locator(".thumbnail-container img").count();

    await page.keyboard.press("Control+t");

    // The new tab shows the same directory seeded from the source pane; its
    // thumbnails must hydrate synchronously from the shared cache.
    await expect(page.locator(".thumbnail-container img")).toHaveCount(imgCount);
    await expect(page.locator(".thumbnail-placeholder")).toHaveCount(0);
  });
});
