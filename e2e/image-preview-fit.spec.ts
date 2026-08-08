/**
 * E2E: normal preview images fit their available pane height (#495).
 */
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

const tallImageDataUrl = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="300" height="1200" viewBox="0 0 300 1200">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2563eb" />
        <stop offset="0.58" stop-color="#38bdf8" />
        <stop offset="1" stop-color="#fef3c7" />
      </linearGradient>
    </defs>
    <rect width="300" height="1200" fill="url(#sky)" />
    <circle cx="226" cy="175" r="68" fill="#fde047" />
    <path d="M0 860 80 700l62 104 74-190 84 246v340H0Z" fill="#15803d" />
    <path d="M0 970 104 810l92 136 104-216v470H0Z" fill="#166534" />
    <text x="150" y="1100" text-anchor="middle" fill="white" font-family="sans-serif" font-size="24">Tall image</text>
  </svg>
`)}`;

test("a tall image fits the normal preview pane without vertical scrolling", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
  }
  await expect(previewPane).toBeVisible();

  await page.locator(".entry-item").filter({ hasText: "photo1.jpg" }).first().click();
  const image = page.locator(".preview-image");
  const content = page.locator(".preview-content");
  await expect(image).toBeVisible({ timeout: 3000 });

  // The browser mock's image is intentionally small. Replace it with a real
  // 300×1200 SVG data URL so the layout handles an actual tall image.
  await image.evaluate(
    (element, src) => new Promise<void>((resolve, reject) => {
      const imageElement = element as HTMLImageElement;
      imageElement.onload = () => resolve();
      imageElement.onerror = () => reject(new Error("Tall image did not load"));
      imageElement.src = src;
    }),
    tallImageDataUrl,
  );

  await expect.poll(async () => content.evaluate((element) => element.scrollHeight)).toBe(
    await content.evaluate((element) => element.clientHeight),
  );

  const [contentBox, imageBox] = await Promise.all([content.boundingBox(), image.boundingBox()]);
  expect(contentBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(imageBox!.y).toBeGreaterThanOrEqual(contentBox!.y);
  expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(contentBox!.y + contentBox!.height);

  // The capture shares the asserted browser state, keeping visual proof and
  // the regression test aligned.
  await page.screenshot({ path: "evidence/ac-1-full-image-no-scroll.png" });
});
