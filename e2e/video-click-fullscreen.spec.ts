/** Clicking the video surface toggles fullscreen, as picture preview does (#1058). */
import { test, expect, type Locator, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openVideo(page: Page, failPreview = false): Promise<Locator> {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-settings", JSON.stringify({ viewMode: "details", showPreviewPane: false,
      previewPanePosition: "right", previewPaneWidth: 300, previewPaneHeight: 220, zoomLevel: 100 }));
  });
  if (failPreview) {
    await page.addInitScript(() => {
      const w = window as unknown as { __mockControl?: Record<string, unknown> };
      (w.__mockControl ??= {}).videoPreview = () => { throw new Error("Video file is unavailable"); };
    });
  }
  await page.goto("/?path=/home/user/Videos");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Videos/recording.mp4"]').click();
  await page.keyboard.press("Space");
  return page.locator(".video-preview");
}

async function playUntilTimeAdvances(player: Locator) {
  await player.getByRole("button", { name: "Play video", exact: true }).click();
  await expect(player.getByLabel("Video time")).toHaveText(/^0:0[1-9] \//);
  await expect(player.getByRole("button", { name: "Pause video", exact: true })).toBeVisible();
}

test("clicking the video enters fullscreen without starting playback, and a second click exits", async ({ page }) => {
  const player = await openVideo(page);
  await expect(player.getByRole("button", { name: "Play video", exact: true })).toBeEnabled();
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

test("Play starts playback in the docked pane", async ({ page }) => {
  const player = await openVideo(page);
  await expect(player.getByRole("button", { name: "Play video", exact: true })).toBeEnabled();
  await playUntilTimeAdvances(player);
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
  await page.screenshot({ path: "evidence/ac-3-play-button-stays-docked.png" });
});

test("a video click during playback enters fullscreen and playback keeps running", async ({ page }) => {
  const player = await openVideo(page);
  await expect(player.getByRole("button", { name: "Play video", exact: true })).toBeEnabled();
  const video = player.locator("video");
  await playUntilTimeAdvances(player);
  const before = await video.evaluate(v => (v as HTMLVideoElement).currentTime);
  await video.click();
  await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  await expect(player.getByRole("button", { name: "Pause video", exact: true })).toBeVisible();
  await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(before);
  expect(await video.evaluate(v => (v as HTMLVideoElement).paused)).toBe(false);
  await expect(player.getByLabel("Video time")).toHaveText(/^0:0[1-9] \//);
  await page.screenshot({ path: "evidence/ac-4-video-click-during-playback.png" });
});

test("clicks on the error overlay and its Open externally button do not toggle fullscreen", async ({ page }) => {
  const player = await openVideo(page, true);
  const external = player.getByRole("button", { name: "Open externally", exact: true });
  await expect(external).toBeVisible();
  const pane = page.locator(".preview-pane");
  await player.locator(".video-message span").click();
  await expect(pane).not.toHaveClass(/fullscreen/);
  await external.click();
  await expect(pane).not.toHaveClass(/fullscreen/);
});
