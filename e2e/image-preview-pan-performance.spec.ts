/**
 * E2E: panning a zoomed image preview remains on the transform compositor path.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

async function openZoomedImage(page: Page) {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
  }
  await page.locator(".entry-item").filter({ hasText: "photo1.jpg" }).first().click();

  const image = page.locator(".preview-image");
  await expect(image).toBeVisible({ timeout: 3000 });
  await image.click();
  await expect(previewPane).toHaveClass(/fullscreen/);
  await page.keyboard.press("+");
  await expect(image).toHaveClass(/zoomed/);
  return image;
}

test("a zoomed image preview pans through a compositor-backed transform", async ({ page }) => {
  const image = await openZoomedImage(page);
  const container = page.locator(".preview-image-container");
  const before = await image.getAttribute("style");
  const box = await container.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 50, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => image.getAttribute("style")).not.toBe(before);
  await expect(image).toHaveAttribute("style", /translate\(80px, 50px\) scale\(1\.25\)/);
  await expect(image).toHaveCSS("will-change", "transform");

  // This capture is taken from the exact panned state asserted above.
  await page.screenshot({ path: "evidence/ac-1-panned-large-image.png" });

  // Wheel from an off-center point. The transformed image must retain that
  // point under the cursor, not zoom around the container's center.
  await page.mouse.move(box!.x + box!.width / 2 - 100, box!.y + box!.height / 2 + 60);
  await page.mouse.wheel(0, -120);
  await expect(image).toHaveAttribute(
    "style",
    /translate\(107px, 48\.5px\) scale\(1\.4375\)/,
  );

  // Wheel zoom continues to update the same visible preview surface.
  await page.screenshot({ path: "evidence/ac-3-wheel-zoom-preview.png" });
});
