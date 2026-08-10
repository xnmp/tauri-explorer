/**
 * Video previews render the extracted still frame in the large preview pane.
 * The mock backend provides the same data URI that the production ffmpeg
 * thumbnail command returns, so this asserts at the rendered browser seam.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("Video preview", () => {
  test("selecting a video displays its still frame and supports fullscreen", async ({ page }) => {
    await page.goto("/?path=/home/user/Videos");
    await waitForEntries(page);

    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
    }
    await expect(previewPane).toBeVisible();

    await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();

    const frame = previewPane.locator(".preview-image");
    await expect(frame).toBeVisible({ timeout: 3000 });
    await expect(frame).toHaveAttribute("alt", "recording.mp4");
    await page.screenshot({ path: "evidence/ac-1-video-preview-frame.png" });

    await frame.click();
    await expect(previewPane).toHaveClass(/fullscreen/);
    await page.screenshot({ path: "evidence/ac-2-video-preview-fullscreen.png" });
  });

  test("shows the unavailable state when frame extraction fails", async ({ page }) => {
    await page.goto("/?path=/home/user/Videos");
    await waitForEntries(page);
    await page.evaluate(() => {
      (window as typeof window & { __MOCK_FAILURES__?: Record<string, string> }).__MOCK_FAILURES__ = {
        get_video_thumbnail_data: "ffmpeg is unavailable",
      };
    });

    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});
    await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();

    await expect(previewPane.locator(".preview-error-text")).toHaveText("Cannot preview video");
    await expect(previewPane.locator(".preview-image")).toHaveCount(0);
  });

  test("does not replace a newer video frame with an earlier delayed frame", async ({ page }) => {
    await page.goto("/?path=/home/user/Videos");
    await waitForEntries(page);
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});

    await page.evaluate(() => {
      (window as typeof window & { __MOCK_LATENCY__?: Record<string, number> }).__MOCK_LATENCY__ = {
        get_video_thumbnail_data: 300,
      };
    });
    await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();
    await page.waitForTimeout(30);
    await page.evaluate(() => {
      (window as typeof window & { __MOCK_LATENCY__?: Record<string, number> }).__MOCK_LATENCY__ = {};
    });
    await page.locator(".entry-item", { hasText: "tutorial.mkv" }).first().click();

    const frame = previewPane.locator(".preview-image");
    await expect(frame).toHaveAttribute("alt", "tutorial.mkv");
    const latestFrameSrc = await frame.getAttribute("src");
    await page.waitForTimeout(350);
    await expect(frame).toHaveAttribute("src", latestFrameSrc!);
  });

  test("does not show a stale extraction error after the selection changes", async ({ page }) => {
    await page.goto("/?path=/home/user/Videos");
    await waitForEntries(page);
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});

    // Delay and reject only the first preview decode. The next selected video
    // still decodes normally, so the late rejection must not replace it with
    // an unavailable-preview error.
    await page.evaluate(() => {
      const originalDecode = HTMLImageElement.prototype.decode;
      let decodeCount = 0;
      HTMLImageElement.prototype.decode = function () {
        if (++decodeCount === 1) {
          return new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("stale frame decode failed")), 500);
          });
        }
        return originalDecode.call(this);
      };
    });

    await page.locator(".entry-item", { hasText: "recording.mp4" }).first().click();
    await page.waitForTimeout(30);
    await page.locator(".entry-item", { hasText: "soundtrack.mp3" }).first().click();

    await page.waitForTimeout(530);
    await expect(previewPane.locator(".preview-error-text")).toHaveCount(0);
  });
});
