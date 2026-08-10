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
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
  }
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
    const frame = (color: string) =>
      `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="${color}"/></svg>`)}`;
    (window as unknown as { __mockVideoThumbnail?: (path: string) => Promise<string> | string }).__mockVideoThumbnail =
      (path) =>
        path.endsWith("recording.mp4")
          ? new Promise((resolve) => window.setTimeout(() => resolve(frame("red")), 350))
          : frame("blue");
  });
  const previewPane = await openVideosWithPreview(page);

  await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();
  await page.locator(".entry-item", { hasText: "tutorial.mkv" }).first().click();

  const frame = previewPane.locator(".preview-image");
  await expect(frame).toHaveAttribute("alt", "tutorial.mkv");
  await page.waitForTimeout(500);
  await expect(frame).toHaveAttribute("alt", "tutorial.mkv");
});
