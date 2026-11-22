/** The Report Issue dialog stays inside small and zoomed windows (#1892). */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openReportDialog(page: Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Report Issue");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Report Issue" });
  await expect(dialog.locator(".user-report-dialog")).toBeVisible();
  return dialog;
}

/** Apply the app's UI zoom the way +page.svelte does for settings.zoomLevel. */
async function setZoom(page: Page, percent: number) {
  await page.evaluate((value) => {
    document.documentElement.style.zoom = `${value}%`;
    document.documentElement.style.setProperty("--app-zoom", String(value / 100));
  }, percent);
}

for (const [width, height, zoom] of [
  [528, 657, 100],
  [500, 400, 100],
  [528, 657, 150],
  [800, 600, 200],
] as const) {
  test(`report dialog fits a ${width}x${height} window at ${zoom}% with header and actions visible`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await waitForEntries(page);
    if (zoom !== 100) await setZoom(page, zoom);

    const dialog = await openReportDialog(page);
    const card = dialog.locator(".user-report-dialog");
    // toBeInViewport measures with IntersectionObserver, so it reports what is
    // actually on screen regardless of root CSS zoom.
    await expect(card).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("heading", { name: "Report Issue" })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("button", { name: /^Submit/ })).toBeInViewport({ ratio: 1 });

    // The form body scrolls inside the card; the actions stay reachable.
    const disclosure = dialog.locator(".report-disclosure");
    await disclosure.scrollIntoViewIfNeeded();
    await expect(disclosure).toBeInViewport();
    await expect(card).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("heading", { name: "Report Issue" })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });
  });
}
