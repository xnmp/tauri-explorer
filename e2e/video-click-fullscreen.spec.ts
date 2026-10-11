/** Clicking the video surface toggles fullscreen, as picture preview does (#1058). */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openVideo(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-settings", JSON.stringify({ viewMode: "details", showPreviewPane: false,
      previewPanePosition: "right", previewPaneWidth: 300, previewPaneHeight: 220, zoomLevel: 100 }));
  });
  await page.goto("/?path=/home/user/Videos");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Videos/recording.mp4"]').click();
  await page.keyboard.press("Space");
  const player = page.locator(".video-preview");
  await expect(player.getByRole("button", { name: "Play video", exact: true })).toBeEnabled();
  return player;
}

test("clicking the video enters fullscreen without starting playback, and a second click exits", async ({ page }) => {
  const player = await openVideo(page);
  const video = player.locator("video");
  const pane = page.locator(".preview-pane");
  await video.click();
  await expect(pane).toHaveClass(/fullscreen/);
  await expect(player.getByRole("button", { name: "Play video", exact: true })).toBeVisible();
  expect(await video.evaluate(v => (v as HTMLVideoElement).paused)).toBe(true);
  await page.screenshot({ path: "evidence/ac-1-video-click-fullscreen.png" });
  await video.click();
  await expect(pane).not.toHaveClass(/fullscreen/);
  await expect(player).toBeVisible();
  await page.screenshot({ path: "evidence/ac-2-video-click-exits-fullscreen.png" });
});

test("Play starts playback without fullscreen, and a video click then keeps playback running in fullscreen", async ({ page }) => {
  const player = await openVideo(page);
  const video = player.locator("video");
  await player.getByRole("button", { name: "Play video", exact: true }).click();
  await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
  await expect(player.getByRole("button", { name: "Pause video", exact: true })).toBeVisible();
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
  await page.screenshot({ path: "evidence/ac-3-play-button-stays-docked.png" });
  await video.click();
  await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  expect(await video.evaluate(v => (v as HTMLVideoElement).paused)).toBe(false);
});
