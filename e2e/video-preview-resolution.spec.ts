/**
 * Video previews need a full preview-sized source, independently from the
 * small, cacheable frame rendered in the Tiles view.
 */
import { test, expect } from "./fixtures";
import { pressShortcut, waitForEntries } from "./helpers";

test("video preview uses a 1024px frame while tiles retain their configured frame size", async ({ page }) => {
  await page.addInitScript(() => {
    type VideoRequest = { path: string; size?: number };
    const mockWindow = window as unknown as {
      __mockVideoThumbnail?: (path: string, size?: number) => string;
      __videoThumbnailRequests?: VideoRequest[];
    };
    mockWindow.__videoThumbnailRequests = [];
    mockWindow.__mockVideoThumbnail = (path, size) => {
      mockWindow.__videoThumbnailRequests?.push({ path, size });
      const sourceSize = size ?? 128;
      return `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${sourceSize}" height="${sourceSize}"><rect width="100%" height="100%" fill="#2563eb"/></svg>`)}`;
    };
  });

  await page.goto("/?path=/home/user/Videos&viewMode=tiles");
  await waitForEntries(page);
  const recordingTile = page.locator(".tile-item", { hasText: "recording.mp4" });
  await expect(recordingTile.locator(".thumbnail-full")).toBeVisible();

  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) await pressShortcut(page, " ");
  await expect(previewPane).toBeVisible();
  await recordingTile.click();

  const frame = previewPane.locator(".preview-image");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("alt", "recording.mp4");
  await page.screenshot({ path: "evidence/ac-1-video-preview-1024px.png" });

  const requestSizes = await page.evaluate(() =>
    (window as unknown as { __videoThumbnailRequests?: Array<{ path: string; size?: number }> })
      .__videoThumbnailRequests
      ?.filter((request) => request.path.endsWith("recording.mp4"))
      .map((request) => request.size),
  );
  expect(requestSizes).toContain(96);
  expect(requestSizes).toContain(1024);

  const requestsBeforeFullscreen = await page.evaluate(() =>
    (window as unknown as { __videoThumbnailRequests?: Array<{ path: string; size?: number }> })
      .__videoThumbnailRequests
      ?.filter((request) => request.path.endsWith("recording.mp4")),
  );
  await frame.click();
  await expect(previewPane).toHaveClass(/fullscreen/);
  await page.screenshot({ path: "evidence/ac-2-video-preview-fullscreen-1024px.png" });

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __videoThumbnailRequests?: Array<{ path: string; size?: number }> })
      .__videoThumbnailRequests
      ?.filter((request) => request.path.endsWith("recording.mp4")),
  )).toEqual(requestsBeforeFullscreen);
});
