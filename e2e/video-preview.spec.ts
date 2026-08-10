/**
 * Video previews render their extracted still frame in the large preview pane.
 * The browser mock returns the same data-URI shape as the ffmpeg thumbnail
 * command, so this verifies the rendered user-visible preview seam.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test("selecting a video displays its still frame and opens fullscreen", async ({ page }) => {
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

  await frame.click();
  await expect(previewPane).toHaveClass(/fullscreen/);
});
