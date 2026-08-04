/**
 * E2E: click the image preview to bring it front and center (#219).
 *
 * Clicking the image in the preview pane enters the fullscreen preview,
 * Left/Right arrows step to the previous/next sibling file, and clicking the
 * image again reverts to the normal pane view. Uses the mock backend's
 * read_image_data_url so a real <img> renders in browser mode.
 */
import { test, expect, type Page } from "./fixtures";
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

async function openPicturesWithPreview(page: Page) {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
  }
  await expect(previewPane).toBeVisible();
}

async function selectAndWaitForImage(page: Page, filename: string) {
  await page.locator(".entry-item").filter({ hasText: filename }).first().click();
  const img = page.locator(".preview-image");
  await expect(img).toBeVisible({ timeout: 3000 });
  await expect(img).toHaveAttribute("alt", filename);
  return img;
}

test.describe("Image preview click-to-fullscreen", () => {
  test("a tall image fits the normal preview pane without vertical scrolling", async ({ page }) => {
    await openPicturesWithPreview(page);
    const image = await selectAndWaitForImage(page, "photo1.jpg");
    const content = page.locator(".preview-content");

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

  test("click enters fullscreen, arrows scroll siblings, click reverts", async ({ page }) => {
    await openPicturesWithPreview(page);
    const img = await selectAndWaitForImage(page, "photo1.jpg");
    const pane = page.locator(".preview-pane");

    // Click the image → front and center.
    await img.click();
    await expect(pane).toHaveClass(/fullscreen/);

    // Right arrow steps to the next sibling image (the preview follows).
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".preview-image")).toHaveAttribute("alt", "photo2.jpg", {
      timeout: 3000,
    });
    await expect(pane).toHaveClass(/fullscreen/);

    // Left arrow steps back.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".preview-image")).toHaveAttribute("alt", "photo1.jpg", {
      timeout: 3000,
    });

    // Click again → back to the normal pane view, preview still showing.
    await page.locator(".preview-image").click();
    await expect(pane).not.toHaveClass(/fullscreen/);
    await expect(page.locator(".preview-image")).toBeVisible();
  });

  test("fullscreen surface stays opaque in island/vibrancy mode (#391)", async ({ page }) => {
    await openPicturesWithPreview(page);
    // Island mode is what Windows Mica/Acrylic (and macOS vibrancy) turn on.
    await page.evaluate(() => document.documentElement.setAttribute("data-vibrancy", ""));
    const img = await selectAndWaitForImage(page, "photo1.jpg");
    const pane = page.locator(".preview-pane");

    await img.click();
    await expect(pane).toHaveClass(/fullscreen/);

    // A transparent surface let the whole app show through behind the image.
    const bg = await pane.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
  });

  test("Escape also exits the clicked-open fullscreen", async ({ page }) => {
    await openPicturesWithPreview(page);
    const img = await selectAndWaitForImage(page, "photo2.jpg");
    const pane = page.locator(".preview-pane");

    await img.click();
    await expect(pane).toHaveClass(/fullscreen/);
    await page.keyboard.press("Escape");
    await expect(pane).not.toHaveClass(/fullscreen/);
  });
});
