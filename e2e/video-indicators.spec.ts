import fs from "node:fs";
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, seedSettings, switchViewMode, waitForEntries, pressShortcut } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

const root = "/video-marker-proof";
const names = ["frame.mp4", "frame.mkv", "frame.WEBM", "failed.avi", "still.jpg", "animated.gif", "cover.mp3", "notes.txt"];
const proof = "screenshots/fix/823-video-thumbnail-indicator";

async function capture(page: import("@playwright/test").Page, name: string) {
  if (process.env.CAPTURE_823 !== "1") return;
  fs.mkdirSync(proof, { recursive: true });
  await page.screenshot({ path: `${proof}/${name}.png` });
}

for (const theme of ["light", "dark"] as const) {
  for (const iconTheme of ["default", "material", "minimal"] as const) {
    test(`${theme} ${iconTheme}: video markers distinguish matching frames across views`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      await seedSettings(page, { theme, iconTheme, zoomLevel: theme === "dark" ? 150 : 100, thumbnailSize: "small" });
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      await page.evaluate(async ({ root, names }) => {
        const fixtureUrl = "/src/lib/api/mock-fixtures.ts";
        const invokeUrl = "/src/lib/api/mock-invoke.ts";
        const { mockFiles } = await import(/* @vite-ignore */ fixtureUrl);
        const { mockInvoke } = await import(/* @vite-ignore */ invokeUrl);
        mockFiles[root] = names.map((name) => ({ name, path: `${root}/${name}`, kind: "file", size: 1000, modified: "2026-10-01T00:00:00Z", ...(name === "frame.mp4" ? { is_symlink: true, symlink_target: `${root}/frame.mkv` } : {}) }));
        const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
        control.videoThumbnail = (path, size) => path.endsWith("failed.avi")
          ? Promise.reject(new Error("frame unavailable"))
          : mockInvoke("get_thumbnail_data", { path: `${root}/still.jpg`, size });
        control.videoPreview = (path) => path.endsWith("failed.avi") ? Promise.reject(new Error("Cannot preview video: file unavailable")) : "/src/lib/api/fixtures/video-preview.webm";
        control.previewReadImage = () => mockInvoke("get_thumbnail_data", { path: `${root}/still.jpg`, size: 256 });
      }, { root, names });
      await page.keyboard.press("Control+l");
      await page.locator(".path-input").fill(root);
      await page.locator(".path-input").press("Enter");
      const row = (name: string) => page.locator(`.entry-item[data-path="${root}/${name}"]`);
      await expect(row("frame.mp4")).toBeVisible();
      for (const mode of ALL_VIEW_MODES) {
        await switchViewMode(page, mode);
        for (const name of names.slice(0, 4)) {
          const marker = row(name).locator(mode === "tiles" ? ".video-indicator" : ".icon-video");
          await expect(marker).toBeVisible();
          await expect(marker).toBeInViewport();
        }
        for (const name of names.slice(4)) {
          await expect(row(name).locator(".video-indicator, .icon-video")).toHaveCount(0);
        }
        await row("frame.mp4").click();
        await expect(row("frame.mp4")).toHaveClass(/selected/);
        await expect(row("frame.mp4")).toHaveAttribute("aria-label", "frame.mp4, video");
        await expect(row("frame.mp4").locator(".symlink-badge")).toBeVisible();
        await capture(page, `${theme}-${iconTheme}-${mode}-small`);
      }
      // Playback and unavailable sources retain the same passive badge.
      const preview = page.locator(".preview-pane");
      if (!(await preview.isVisible())) await pressShortcut(page, " ", {});
      await row("frame.mp4").click();
      await expect(preview.getByRole("button", {name:"Play video",exact:true})).toBeEnabled();
      await expect(preview.locator(".video-indicator")).toBeVisible();
      await expect(preview.getByRole("region")).toHaveAttribute("aria-label", "Preview of frame.mp4 (video)");
      await expect(preview.locator(".video-indicator")).not.toHaveAttribute("role", "button");
      await capture(page, `${theme}-${iconTheme}-video-preview`);
      await preview.getByRole("button", {name:"View video fullscreen",exact:true}).click();
      await expect(preview).toHaveClass(/fullscreen/);
      const exit = await preview.locator(".fullscreen-exit").boundingBox();
      const marker = await preview.locator(".video-indicator").boundingBox();
      expect(marker!.y).toBeGreaterThan(exit!.y + exit!.height);
      await expect(preview.locator(".video-indicator")).toBeInViewport();
      await capture(page, `${theme}-${iconTheme}-video-fullscreen`);
      await page.keyboard.press("Escape");
      await expect(preview).not.toHaveClass(/fullscreen/);
      await row("still.jpg").click();
      await expect(preview.locator(".preview-image")).toHaveAttribute("alt", "still.jpg");
      await expect(preview.locator(".video-indicator")).toHaveCount(0);
      await capture(page, `${theme}-${iconTheme}-image-preview`);
      await row("failed.avi").click();
      await expect(preview.locator(".video-message")).toContainText("Cannot preview video");
      await expect(preview.locator(".video-indicator")).toBeVisible();
      await row("cover.mp3").click();
      await expect(preview.locator(".preview-image")).toHaveAttribute("alt", "cover.mp3");
      await expect(preview.locator(".video-indicator")).toHaveCount(0);
      await page.keyboard.press("Control+,");
      const settings = page.locator(".settings-dialog");
      await expect(settings).toBeVisible();
      const sizeSetting = settings.locator(".setting-row").filter({ has: page.locator(".setting-label", { hasText: /^Thumbnail Size$/ }) });
      await sizeSetting.locator("select").selectOption("xlarge");
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expect(row("frame.mp4").locator(".tile-icon")).toHaveCSS("width", "128px");
      await expect(row("frame.mp4").locator(".video-indicator")).toBeVisible();
      await row("frame.mp4").click();
      await expect(preview.locator(".video-preview")).toHaveAttribute("aria-label", "Video player for frame.mp4");
      await expect(preview.getByRole("button", {name:"Play video",exact:true})).toBeEnabled();
      await capture(page, `${theme}-${iconTheme}-tiles-xlarge`);
      // A refreshed path changing type must shed the former video's marker.
      await page.evaluate(async ({ root }) => {
        const fixtureUrl = "/src/lib/api/mock-fixtures.ts";
        const { mockFiles } = await import(/* @vite-ignore */ fixtureUrl);
        mockFiles[root] = mockFiles[root].map((entry: { name: string; path: string }) => entry.name === "frame.mp4" ? { ...entry, name: "replacement.jpg", path: `${root}/replacement.jpg` } : entry);
      }, { root });
      await page.keyboard.press("F5");
      await expect(row("frame.mp4")).toHaveCount(0);
      await row("replacement.jpg").click();
      await expect(row("replacement.jpg").locator(".video-indicator, .icon-video")).toHaveCount(0);
      await expect(preview.locator(".preview-image")).toHaveAttribute("alt", "replacement.jpg");
      await expect(preview.locator(".video-indicator")).toHaveCount(0);
    });
  }
}

test("late video response cannot leave a video marker on an image selection", async ({ page }) => {
  await page.addInitScript(() => {
    const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
    control.videoPreview = () => new Promise((resolve) => setTimeout(() => resolve("/src/lib/api/fixtures/video-preview.webm"), 350));
  });
  await page.goto("/?path=/home/user/Videos");
  await waitForEntries(page);
  const preview = page.locator(".preview-pane");
  if (!(await preview.isVisible())) await pressShortcut(page, " ", {});
  await page.locator('.entry-item[data-path="/home/user/Videos/recording.mp4"]').click();
  await expect(preview.locator(".video-indicator")).toBeVisible();
  await page.keyboard.press("Control+l");
  await page.locator(".path-input").fill("/home/user/Pictures");
  await page.locator(".path-input").press("Enter");
  await page.locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]').click();
  await expect(preview.locator(".preview-image")).toHaveAttribute("alt", "photo1.jpg");
  await page.waitForTimeout(450);
  await expect(preview.locator(".video-indicator")).toHaveCount(0);
});
