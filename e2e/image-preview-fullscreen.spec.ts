/**
 * E2E: click the image preview to bring it front and center (#219).
 *
 * Clicking the image in the preview pane enters the fullscreen preview,
 * Left/Right arrows step to the previous/next sibling file, and clicking the
 * image again reverts to the normal pane view. Uses the mock backend's
 * read_image_data_url so a real <img> renders in browser mode.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";

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
