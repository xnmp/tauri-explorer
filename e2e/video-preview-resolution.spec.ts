import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

// Linux's headless WPE proxy advances time but emits transparent video frames.
// CI uses GTK on an isolated Xvfb display for decoder outcomes (#970).
test.use({ headless: process.env.PW_VIDEO_HEADED !== "1" });

test("video playback leaves Tiles' cached thumbnail size independent", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-settings",JSON.stringify({viewMode:"tiles",showPreviewPane:true}));
    const w = window as unknown as {__mockControl?:MockControl;__videoSizes:number[]}; w.__videoSizes=[];
    (w.__mockControl ??= {}).videoThumbnail=(_,size) => {
      w.__videoSizes.push(size ?? 128);
      return `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="blue"/></svg>')}`;
    };
  });
  await page.goto("/?path=/home/user/Videos"); await waitForEntries(page);
  const tile=page.locator('.tile-item[data-path="/home/user/Videos/recording.mp4"]');
  await expect(tile.locator(".thumbnail-full")).toBeVisible(); await tile.click();
  const player=page.locator(".video-preview");
  await expect(player.getByRole("button",{name:"Play video",exact:true})).toBeEnabled();
  await player.getByRole("button",{name:"Play video",exact:true}).click();
  await expect.poll(() => player.locator("video").evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
  const sizes=await page.evaluate(() => (window as unknown as {__videoSizes:number[]}).__videoSizes);
  expect(sizes).toContain(96); expect(sizes).not.toContain(1024);
  await expect(tile.locator(".thumbnail-full")).toBeVisible();
  await expect(page.locator(".video-preview-marker")).toBeVisible();
});
