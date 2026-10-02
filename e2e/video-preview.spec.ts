/** Real browser decoder outcomes; native transport is verified separately. */
import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

// Linux's headless WPE proxy advances time but emits transparent video frames.
// CI uses GTK on an isolated Xvfb display for decoder outcomes (#970).
test.use({ headless: process.env.PW_VIDEO_HEADED !== "1" });

async function openVideo(page: Page, mode = "details", dock = "right", zoom = 100, waitForReady = true,
  size = { width: 300, height: 220 }) {
  await page.addInitScript(({ mode, dock, zoom, size }) => {
    localStorage.setItem("explorer-settings", JSON.stringify({ viewMode: mode, showPreviewPane: false,
      previewPanePosition: dock, previewPaneWidth: size.width, previewPaneHeight: size.height, zoomLevel: zoom }));
  }, { mode, dock, zoom, size });
  await page.goto("/?path=/home/user/Videos");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Videos/recording.mp4"]').click();
  await page.keyboard.press("Space");
  const player = page.locator(".video-preview");
  if (waitForReady) await expect(player.getByRole("button", { name: "Play video", exact: true })).toBeEnabled();
  return player;
}
async function decodedColor(page: Page) {
  return page.locator(".video-preview video").evaluate(element => {
    const video = element as HTMLVideoElement;
    const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d")!; context.drawImage(video, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
}
for (const mode of ALL_VIEW_MODES) {
  test(`${mode}: explicit play, pause, seek, sound and fullscreen work on decoded video`, async ({ page }) => {
    const player = await openVideo(page, mode);
    const video = player.locator("video");
    expect(await video.evaluate(v => (v as HTMLVideoElement).paused)).toBe(true);
    expect(await video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBe(0);
    await player.getByRole("button", { name: "Play video", exact: true }).click();
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    await player.getByRole("button", { name: "Pause video", exact: true }).click();
    expect(await video.evaluate(v => (v as HTMLVideoElement).paused)).toBe(true);
    await player.getByRole("slider", { name: "Seek video", exact: true }).fill("4");
    await expect.poll(async () => { const c = await decodedColor(page); return c[2] > 220 && c[0] < 30; }).toBe(true);
    await expect(player.locator(".video-time")).toHaveText("0:04 / 0:06");
    await player.getByRole("button", { name: "Mute video", exact: true }).click();
    expect(await video.evaluate(v => (v as HTMLVideoElement).muted)).toBe(true);
    await player.getByRole("slider", { name: "Video volume", exact: true }).fill("0.25");
    expect(await video.evaluate(v => [(v as HTMLVideoElement).volume, (v as HTMLVideoElement).muted])).toEqual([0.25,false]);
    await player.getByRole("button", { name: "View video fullscreen", exact: true }).click();
    await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
    for (const control of await player.locator(".video-controls button,.video-controls input").all()) {
      await expect(control).toBeInViewport();
      expect(await control.evaluate(element => {
        const rect=element.getBoundingClientRect();
        const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
        return {unobscured:element.contains(hit),control:element.getAttribute("aria-label"),hit:hit?.className};
      })).toMatchObject({unobscured:true});
    }
    await expect.poll(async () => { const c = await decodedColor(page); return c[2] > 220 && c[0] < 30; }).toBe(true);
    await player.focus(); await page.keyboard.press("Home");
    await expect.poll(async () => { const c = await decodedColor(page); return c[0] > 220 && c[2] < 30; }).toBe(true);
    await page.keyboard.down("Space");
    await page.keyboard.down("Space"); // A held playback key must not toggle Explorer's preview.
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    expect(await video.evaluate(v => (v as HTMLVideoElement).paused)).toBe(false);
    await page.keyboard.up("Space");
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");
    await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
    await expect(player).toBeVisible();
  });
}
for (const dock of ["right", "top", "bottom"]) {
  test(`minimum ${dock} dock retains decoded video and reachable controls at 150%`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    const player = await openVideo(page, "details", dock, 150, true, { width: 160, height: 120 });
    const video = player.locator("video");
    await expect(video).toBeVisible();
    await expect(player.getByRole("button", { name: "Play video", exact: true })).toBeEnabled();
    const initial = await video.boundingBox();
    expect(initial!.height).toBeGreaterThanOrEqual(24 * 1.5 - 1);
    await player.getByRole("button", { name: "Play video", exact: true }).click();
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    await player.getByRole("button", { name: "Pause video", exact: true }).click();
    const seek = player.getByRole("slider", { name: "Seek video", exact: true });
    await seek.scrollIntoViewIfNeeded();
    await expect(seek).toBeInViewport();
    await seek.fill("4");
    await expect.poll(async () => (await decodedColor(page))[2]).toBeGreaterThan(220);
    for (const control of await player.locator(".video-controls button,.video-controls input").all()) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      expect(await control.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
    }
    await player.evaluate(element => { element.scrollTop = 0; });
    if (process.env.CAPTURE_EVIDENCE) {
      await page.screenshot({ path: `screenshots/test/972-preview-containment/minimum-${dock}-150.png` });
    }
    await player.getByRole("button", { name: "View video fullscreen", exact: true }).click();
    await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
    await expect(video).toBeVisible();
  });
  test(`video controls remain operable at 150% in narrow ${dock} dock`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    const player = await openVideo(page, "details", dock, 150);
    for (const control of [player.getByRole("button", { name: "Play video", exact:true }),
      player.getByRole("slider", { name:"Seek video", exact:true }), player.getByRole("button", { name:"Mute video", exact:true }),
      player.getByRole("slider", { name:"Video volume", exact:true }), player.getByRole("button", {name:"View video fullscreen",exact:true})]) {
      await expect(control).toBeInViewport();
      const bounds = await control.boundingBox(); const pane = await player.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(pane!.x-1);
      expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(pane!.x+pane!.width+1);
    }
    await player.getByRole("button", {name:"Play video",exact:true}).click();
    await expect.poll(() => player.locator("video").evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    await player.getByRole("button", {name:"Pause video",exact:true}).click();
    await player.getByRole("slider", {name:"Seek video",exact:true}).fill("4");
    await expect.poll(async () => (await decodedColor(page))[2]).toBeGreaterThan(220);
  });
}
test("fullscreen video covers an open terminal's resize handle", async ({ page }) => {
  const player = await openVideo(page);
  await page.keyboard.press("Control+`");
  await expect(page.locator(".terminal-panel")).toBeVisible();
  const resize = await page.locator(".terminal-panel .resize-handle").boundingBox();
  expect(resize).not.toBeNull();
  await player.getByRole("button", {name:"View video fullscreen",exact:true}).click();
  expect(await page.evaluate(rect => {
    const hit = document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2);
    return {covered:!!hit?.closest(".video-preview"),hit:hit?.className};
  }, resize!)).toMatchObject({covered:true});
});
test("unavailable source explains failure and offers external opening", async ({ page }) => {
  await page.addInitScript(() => { ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).videoPreview = () => {throw new Error("Video file is unavailable");}; });
  await page.addInitScript(() => localStorage.setItem("explorer-settings",JSON.stringify({showPreviewPane:true})));
  await page.goto("/?path=/home/user/Videos"); await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Videos/recording.mp4"]').click();
  await expect(page.locator(".video-message")).toContainText("Video file is unavailable");
  await expect(page.getByRole("button",{name:"Open externally",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Play video",exact:true})).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockControl?: MockControl }).__mockControl?.releasedVideoPreviews?.length)).toBe(1);
});
test("minimum dock keeps the complete media error and external-open action reachable", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.addInitScript(() => {
    ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).videoPreview = () => {
      throw new Error("Video file is unavailable");
    };
  });
  const player = await openVideo(page, "details", "bottom", 150, false, { width: 160, height: 120 });
  const message = player.getByRole("status");
  await expect(message).toContainText("Video file is unavailable");
  const text = message.locator("span");
  await text.scrollIntoViewIfNeeded();
  expect(await text.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const message = element.closest(".video-message")!.getBoundingClientRect();
    const stage = element.closest(".video-stage")!.getBoundingClientRect();
    const player = element.closest(".video-preview")!.getBoundingClientRect();
    return rect.top >= Math.max(message.top, stage.top, player.top) - 1 &&
      rect.bottom <= Math.min(message.bottom, stage.bottom, player.bottom) + 1;
  })).toBe(true);
  const external = message.getByRole("button", { name: "Open externally", exact: true });
  await external.scrollIntoViewIfNeeded();
  expect(await external.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const stage = element.closest(".video-stage")!.getBoundingClientRect();
    const message = element.closest(".video-message")!.getBoundingClientRect();
    const player = element.closest(".video-preview")!.getBoundingClientRect();
    return rect.top >= Math.max(stage.top, message.top, player.top) - 1 &&
      rect.bottom <= Math.min(stage.bottom, message.bottom, player.bottom) + 1;
  })).toBe(true);
  if (process.env.CAPTURE_EVIDENCE) {
    await page.screenshot({ path: "screenshots/test/972-preview-containment/minimum-error-150.png" });
  }
  await external.click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __mockControl?: MockControl }).__mockControl?.invokeCounts?.open_file ?? 0,
  )).toBe(1);
});
test("changing selection and hiding preview unload the old playing source", async ({ page }) => {
  const player = await openVideo(page);
  await player.getByRole("button",{name:"Play video",exact:true}).click();
  const oldVideo = await player.locator("video").elementHandle();
  await page.locator('.entry-item[data-path="/home/user/Videos/tutorial.mkv"]').click();
  await expect(page.locator(".video-preview")).toHaveAttribute("aria-label", "Video player for tutorial.mkv");
  await expect(page.getByRole("button",{name:"Play video",exact:true})).toBeEnabled();
  expect(await oldVideo!.evaluate(v => [(v as HTMLVideoElement).paused, v.getAttribute("src")])).toEqual([true,null]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockControl?: MockControl }).__mockControl?.releasedVideoPreviews?.length)).toBe(1);
  await page.locator('.entry-item[data-path="/home/user/Videos/tutorial.mkv"]').focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".video-preview")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockControl?: MockControl }).__mockControl?.releasedVideoPreviews?.length)).toBe(2);
});
test("late admission cannot replace a newer selected video's source", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {__mockControl?:MockControl; __admissions:Array<{path:string;resolve(url:string):void}>};
    w.__admissions=[];
    (w.__mockControl ??= {}).videoPreview = path => new Promise(resolve => w.__admissions.push({path,resolve}));
  });
  const player = await openVideo(page,"details","right",100,false);
  await expect.poll(() => page.evaluate(() => (window as unknown as {__admissions:unknown[]}).__admissions.length)).toBe(1);
  await expect(player).toHaveAttribute("aria-label","Video player for recording.mp4");
  await player.focus(); await page.keyboard.press("Space"); await page.keyboard.press("Enter");
  await expect(page.locator(".preview-pane")).toBeVisible();
  await expect(player).toHaveAttribute("aria-label","Video player for recording.mp4");
  expect(await page.evaluate(() => (window as unknown as {__mockControl?:MockControl}).__mockControl?.invokeCounts?.open_file ?? 0)).toBe(0);
  await page.locator('.entry-item[data-path="/home/user/Videos/tutorial.mkv"]').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {__admissions:unknown[]}).__admissions.length)).toBe(2);
  await page.evaluate(() => (window as unknown as {__admissions:Array<{resolve(url:string):void}>}).__admissions[1].resolve("/src/lib/api/fixtures/video-preview.webm"));
  await expect(player).toHaveAttribute("aria-label","Video player for tutorial.mkv");
  await expect(player.getByRole("button",{name:"Play video",exact:true})).toBeEnabled();
  await page.evaluate(() => (window as unknown as {__admissions:Array<{resolve(url:string):void}>}).__admissions[0].resolve("/src/lib/api/fixtures/video-preview.webm"));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockControl?: MockControl }).__mockControl?.releasedVideoPreviews?.length)).toBe(1);
  await expect(player).toHaveAttribute("aria-label","Video player for tutorial.mkv");
  expect(await player.locator("video").evaluate(v => (v as HTMLVideoElement).paused)).toBe(true);
});

test("an open modal owns input even if a media key reaches the background player", async ({ page }) => {
  const player=await openVideo(page);
  await player.focus(); await page.keyboard.press("Control+,");
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await player.dispatchEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true});
  await player.dispatchEvent("keydown",{key:"m",code:"KeyM",bubbles:true,cancelable:true});
  expect(await player.locator("video").evaluate(v => [(v as HTMLVideoElement).paused,(v as HTMLVideoElement).muted])).toEqual([true,false]);
  await expect(page.locator(".settings-dialog")).toBeVisible();
});

test("a decoder failure releases the source and keeps an external-open error", async ({ page }) => {
  await page.addInitScript(() => { ((window as unknown as {__mockControl?:MockControl}).__mockControl ??= {}).videoPreview=() => "/src/lib/api/fixtures/preview-landmarks.pdf"; });
  await openVideo(page,"details","right",100,false);
  await expect(page.locator(".video-message")).toContainText("not supported by your system");
  await expect(page.getByRole("button",{name:"Open externally",exact:true})).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as {__mockControl?:MockControl}).__mockControl?.releasedVideoPreviews?.length)).toBe(1);
  expect(await page.locator(".video-preview video").getAttribute("src")).toBeNull();
});
test("a changed revision unloads playback and returns the same file to paused state", async ({ page }) => {
  const player=await openVideo(page); const old=await player.locator("video").elementHandle();
  await player.getByRole("button",{name:"Play video",exact:true}).click();
  await expect.poll(() => player.locator("video").evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
  await page.evaluate(() => (window as unknown as {__mockControl?:MockControl}).__mockControl?.videoRevision?.());
  await page.locator('.entry-item[data-path="/home/user/Videos/recording.mp4"]').focus(); await page.keyboard.press("F5");
  await expect.poll(() => page.evaluate(() => (window as unknown as {__mockControl?:MockControl}).__mockControl?.releasedVideoPreviews?.length)).toBe(1);
  await expect(player.getByRole("button",{name:"Play video",exact:true})).toBeEnabled();
  expect(await old!.evaluate(v => [(v as HTMLVideoElement).paused,v.getAttribute("src")])).toEqual([true,null]);
  expect(await player.locator("video").evaluate(v => [(v as HTMLVideoElement).paused,(v as HTMLVideoElement).currentTime])).toEqual([true,0]);
});

test("a playback rejection followed by a media error keeps its message and releases once", async ({ page }) => {
  const player=await openVideo(page);
  await player.locator("video").evaluate(element => {
    (element as HTMLVideoElement).play=() => Promise.reject(new DOMException("Playback unavailable","NotAllowedError"));
  });
  await player.getByRole("button",{name:"Play video",exact:true}).click();
  await expect(player.locator(".video-message")).toContainText("Cannot start playback: Playback unavailable");
  expect(await player.locator("video").getAttribute("src")).toBeNull();
  await player.locator("video").dispatchEvent("error");
  await expect(player.locator(".video-message")).toContainText("Cannot start playback: Playback unavailable");
  await expect.poll(() => page.evaluate(() => (window as unknown as {__mockControl?:MockControl}).__mockControl?.releasedVideoPreviews?.length)).toBe(1);
});
