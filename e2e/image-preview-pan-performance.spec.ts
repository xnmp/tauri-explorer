/**
 * E2E: panning a zoomed image preview remains on the transform compositor path.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

// A 2400×1600 grid makes the zoomed preview larger than the fullscreen
// viewport. Its labelled landmarks make drag and cursor-anchored zoom changes
// unambiguous in the visual evidence rather than relying on the tiny mock JPG.
const largeImageDataUrl = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600" viewBox="0 0 2400 1600">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#075985" />
        <stop offset="1" stop-color="#0f766e" />
      </linearGradient>
      <pattern id="grid" width="200" height="200" patternUnits="userSpaceOnUse">
        <path d="M 200 0 L 0 0 0 200" fill="none" stroke="#e0f2fe" stroke-width="12" opacity=".75" />
      </pattern>
    </defs>
    <rect width="2400" height="1600" fill="url(#sky)" />
    <rect width="2400" height="1600" fill="url(#grid)" />
    <g fill="#fef3c7" font-family="sans-serif" font-weight="700" text-anchor="middle">
      <text x="400" y="300" font-size="92">NORTHWEST</text>
      <text x="880" y="818" font-size="116">WHEEL ANCHOR</text>
      <text x="2000" y="1300" font-size="92">SOUTHEAST</text>
    </g>
    <!-- This landmark maps to the off-centre wheel point used below. It must
         remain at the same screen location in the before/after captures. -->
    <circle cx="880" cy="818" r="88" fill="none" stroke="#f472b6" stroke-width="28" />
    <path d="M880 668v300M730 818h300" stroke="#f472b6" stroke-width="28" />
  </svg>
`)}`;

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
  await image.evaluate(
    (element, src) => new Promise<void>((resolve, reject) => {
      const imageElement = element as HTMLImageElement;
      imageElement.onload = () => resolve();
      imageElement.onerror = () => reject(new Error("Large evidence image did not load"));
      imageElement.src = src;
    }),
    largeImageDataUrl,
  );
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

  // Before/after captures show labelled landmarks moving across a genuinely
  // oversized image, making the drag result directly reviewable.
  await page.screenshot({ path: "evidence/ac-1-large-image-before-drag.png" });

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 50, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => image.getAttribute("style")).not.toBe(before);
  await expect(image).toHaveAttribute("style", /translate\(80px, 50px\) scale\(1\.25\)/);
  await expect(image).toHaveCSS("will-change", "transform");

  await page.screenshot({ path: "evidence/ac-1-large-image-after-drag.png" });
  // The same running zoomed preview is the visual counterpart to the
  // computed `will-change: transform` assertion immediately above.
  await page.screenshot({ path: "evidence/ac-2-transform-compositor-active.png" });

  // Wheel from an off-center point. The transformed image must retain that
  // point under the cursor, not zoom around the container's center.
  await page.mouse.move(box!.x + box!.width / 2 - 100, box!.y + box!.height / 2 + 60);
  await page.screenshot({ path: "evidence/ac-3-wheel-anchor-before.png" });
  await page.mouse.wheel(0, -120);
  await expect(image).toHaveAttribute(
    "style",
    /translate\(107px, 48\.5px\) scale\(1\.4375\)/,
  );

  // The before/after pair keeps the labelled landmark at the wheel anchor
  // while showing its larger zoom level; the earlier drag capture proves
  // drag-to-pan remains available in the same fullscreen mode.
  await page.screenshot({ path: "evidence/ac-3-wheel-anchor-after.png" });
});
