/**
 * Video previews render their extracted still frame in the large preview pane.
 * The browser mock returns the same data-URI shape as the ffmpeg thumbnail
 * command, so this verifies the rendered user-visible preview seam.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

async function openVideosWithPreview(page: import("@playwright/test").Page) {
  await page.goto("/?path=/home/user/Videos");
  await waitForEntries(page);

  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});
  await expect(previewPane).toBeVisible();
  return previewPane;
}

test("selecting a video displays its still frame and opens fullscreen", async ({ page }) => {
  const previewPane = await openVideosWithPreview(page);
  await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();

  const frame = previewPane.locator(".preview-image");
  await expect(frame).toBeVisible({ timeout: 3000 });
  await expect(frame).toHaveAttribute("alt", "recording.mp4");
  await page.screenshot({ path: "evidence/ac-1-video-preview-frame.png" });

  await frame.click();
  await expect(previewPane).toHaveClass(/fullscreen/);
  await page.screenshot({ path: "evidence/ac-2-video-preview-fullscreen.png" });
});

test("a failed frame extraction shows the unavailable preview state", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __mockVideoThumbnail?: () => string }).__mockVideoThumbnail = () => {
      throw new Error("ffmpeg unavailable");
    };
  });
  const previewPane = await openVideosWithPreview(page);
  await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();
  await expect(previewPane).toContainText("Cannot preview video");
  await expect(previewPane.locator(".preview-image")).toHaveCount(0);
});

test("a late frame from a previously selected video cannot replace the current frame", async ({ page }) => {
  await page.addInitScript(() => {
    const frame = (color: string) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="${color}"/></svg>`)}`;
    (window as unknown as { __mockVideoThumbnail?: (path: string) => Promise<string> | string }).__mockVideoThumbnail = (path) =>
      path.endsWith("recording.mp4") ? new Promise((resolve) => window.setTimeout(() => resolve(frame("red")), 350)) : frame("blue");
  });
  const previewPane = await openVideosWithPreview(page);
  await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();
  await page.locator(".entry-item", { hasText: "tutorial.mkv" }).first().click();

  const frame = previewPane.locator(".preview-image");
  await expect(frame).toHaveAttribute("alt", "tutorial.mkv");
  await page.waitForTimeout(500);
  await expect(frame).toHaveAttribute("alt", "tutorial.mkv");
});

test("a late frame from a previous revision keeps the new revision loading", async ({ page }) => {
  await page.addInitScript(() => {
    let recordingRequest = 0;
    const frame = (color: string) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="${color}"/></svg>`)}`;
    (window as unknown as { __mockVideoThumbnail?: (path: string) => Promise<string> | string }).__mockVideoThumbnail = (path) => {
      if (!path.endsWith("recording.mp4")) return frame("gray");
      recordingRequest += 1;
      return new Promise((resolve) => window.setTimeout(() => resolve(frame(recordingRequest === 1 ? "red" : "blue")), recordingRequest === 1 ? 350 : 700));
    };
  });
  const previewPane = await openVideosWithPreview(page);
  await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();
  await page.evaluate(() => (window as unknown as { __mockVideoRevision?: () => void }).__mockVideoRevision?.());
  await page.keyboard.press("F5");

  await page.waitForTimeout(450);
  await expect(previewPane.locator(".preview-loading")).toBeVisible();
  await expect(previewPane.locator(".preview-image")).toHaveCount(0);

  const frame = previewPane.locator(".preview-image");
  await expect(frame).toHaveAttribute("alt", "recording.mp4");
  const pixel = await frame.evaluate((element) => {
    const image = element as HTMLImageElement;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return [...canvas.getContext("2d")!.getImageData(1, 1, 1, 1).data];
  });
  expect(pixel).toEqual([0, 0, 255, 255]);
});
