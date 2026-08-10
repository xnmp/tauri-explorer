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
});
