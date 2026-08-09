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

async function dockPreview(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await expect(palette).toBeVisible();
  await palette.locator(".search-input").fill(label);
  await palette.locator(`.command-item:has-text("${label}")`).first().click();
  await expect(palette).toBeHidden();
}

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
  test("click enters fullscreen, arrows scroll siblings, click reverts", async ({ page }) => {
    await openPicturesWithPreview(page);
    const img = await selectAndWaitForImage(page, "photo1.jpg");
    const pane = page.locator(".preview-pane");

    // Click the image → front and center.
    await img.click();
    await expect(pane).toHaveClass(/fullscreen/);
    await page.screenshot({ path: "evidence/ac-4-right-fullscreen.png" });

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

  for (const [dock, command] of [
    ["bottom", "Dock Preview Pane Bottom"],
    ["top", "Dock Preview Pane Top"],
  ] as const) {
    test(`fullscreen covers the explorer viewport from the ${dock} dock`, async ({ page }) => {
      await openPicturesWithPreview(page);
      await dockPreview(page, command);
      const pane = page.locator(".preview-pane");
      const dockedBox = await pane.boundingBox();
      expect(dockedBox).not.toBeNull();
      expect(dockedBox!.height).toBeLessThan(page.viewportSize()!.height);

      const img = await selectAndWaitForImage(page, "photo1.jpg");
      await img.click();
      await expect(pane).toHaveClass(/fullscreen/);

      const fullscreenBox = await pane.boundingBox();
      const viewport = page.viewportSize()!;
      expect(fullscreenBox).not.toBeNull();
      expect(fullscreenBox!.x).toBe(0);
      expect(fullscreenBox!.y).toBe(0);
      expect(fullscreenBox!.width).toBe(viewport.width);
      expect(fullscreenBox!.height).toBe(viewport.height);
      await page.screenshot({ path: `evidence/ac-${dock === "bottom" ? "1-bottom" : "2-top"}-fullscreen.png` });

      await page.locator(".preview-image").click();
      await expect(pane).not.toHaveClass(/fullscreen/);
      const restoredBox = await pane.boundingBox();
      expect(restoredBox).not.toBeNull();
      expect(restoredBox!.height).toBeCloseTo(dockedBox!.height, 0);
      if (dock === "top") {
        await page.screenshot({ path: "evidence/ac-3-restored-top-dock.png" });
      }
    });
  }
});
