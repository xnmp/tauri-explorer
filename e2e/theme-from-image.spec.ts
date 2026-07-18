/**
 * Theme from Image plugin (#203): right-click an image → a generated theme
 * is written, discovered, and APPLIED — asserted on <html data-theme> and
 * the live accent variable, not just a toast.
 */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("context menu generates and applies a theme from an image", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);

  const image = page.locator(".entry-item", { hasText: ".jpg" }).first();
  await image.click({ button: "right" });

  const item = page.locator(".context-menu .menu-item", { hasText: "Create Theme from Image" });
  await expect(item).toBeVisible();
  await item.click();

  // The generated theme id derives from the image name (img-<basename>).
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
    .toMatch(/^img-/);

  // The mock palette's most saturated color (#d98500 orange) drives the accent.
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  );
  expect(accent).toBe("#d98500");

  await expect(page.locator(".toast")).toContainText("created and applied");
});

test("context item hidden for non-image files", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);

  await page.locator(".entry-item", { hasText: "README.md" }).first().click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
  await expect(
    page.locator(".context-menu .menu-item", { hasText: "Create Theme from Image" }),
  ).toHaveCount(0);
});

test("Create Theme from Wallpaper without a wallpaper explains itself", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Create Theme from Wallpaper");
  await page.keyboard.press("Enter");

  await expect(page.locator(".toast")).toContainText("No wallpaper set");
});
