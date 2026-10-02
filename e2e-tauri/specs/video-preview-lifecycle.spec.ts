/** Actual Linux view selection, warm activation and backend window-retirement outcomes. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createNativeFixtureDirectory } from "../native-qualification";
import { nativeFileIdentity } from "../native-resources";
import { navigateTo, entryPathSelector, parkedWarmWindow, windowOperation } from "./helpers";
import {
  videoCommand, videoState, videoStats, rangeKeys, screenshotPixels, mediaFileHandles,
} from "../video-observations";

const enabled = process.platform === "linux" && !!process.env.TAURI_NATIVE_VIDEO_PROFILE;
const output = process.env.TAURI_NATIVE_VIDEO_ARTIFACT_DIR ?? "e2e-tauri/logs/video-preview-lifecycle";
const proof = "screenshots/feat/970-ability-to-watch-videos-in-the-preview-pane";
const report = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
let directory: string, colors: string, text: string, owner: string;

async function ready() {
  await $('[aria-label="Play video"]').waitForEnabled({ timeout: 20_000 });
  const state = await videoState();
  expect(state?.duration).toBe(6);
  expect(state?.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/media\/[a-f0-9]{48}$/);
  return state!;
}

async function select(file: string) {
  await $(entryPathSelector(file)).click();
  if (!await $(".preview-pane").isDisplayed()) await videoCommand("Toggle Preview Pane");
  return ready();
}

async function cleanup() {
  await browser.waitUntil(async () => {
    const stats = await videoStats();
    return stats.active_leases === 0 && stats.active_connections === 0 &&
      stats.open_workers === 0 && stats.active_streams === 0 &&
      mediaFileHandles(nativeFileIdentity(colors)).length === 0;
  }, { timeout: 15_000, timeoutMsg: "Native video resources survived view/window retirement" });
  return videoStats();
}

async function seekBlue() {
  await rangeKeys('[aria-label="Seek video"]', 40);
  await browser.waitUntil(async () => {
    const state = await videoState();
    return !!state && !state.seeking && state.readyState >= 2 &&
      Math.abs(state.currentTime - 4) < 0.15;
  });
}

async function revoked(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || !/^\/media\/[a-f0-9]{48}$/.test(parsed.pathname)) {
    throw new Error("Unowned native media URL");
  }
  await browser.waitUntil(() => new Promise<boolean>((resolve, reject) => {
    const request = http.request(parsed, { method: "HEAD", agent: false }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode === 404));
    });
    request.on("error", reject);
    request.end();
  }), { timeoutMsg: "Retired native video capability remained usable" });
}

/** WebView pixels remain attributable when two owned native clients are visible. */
async function childBlue(file: string) {
  const state = (await videoState())!;
  await browser.saveScreenshot(file);
  const metadata = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=width,height", "-of", "json", file,
  ], { encoding: "utf8" })).streams[0];
  const x = Math.round((state.rect.x + state.rect.width / 2) * metadata.width / state.viewport.width - 4);
  const y = Math.round((state.rect.y + state.rect.height / 2) * metadata.height / state.viewport.height - 4);
  const pixels = execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", file, "-vf", `crop=9:9:${x}:${y}`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  const rgb = [0, 1, 2].map(channel =>
    Array.from({ length: 81 }, (_, i) => pixels[i * 3 + channel]).reduce((sum, value) => sum + value, 0) / 81);
  expect(rgb[2]).toBeGreaterThan(210);
  expect(rgb[0]).toBeLessThan(40);
  return { state, rgb };
}

(enabled ? describe : describe.skip)("native video views and actual window retirement (#970)", function () {
  this.bail(true);
  before(async () => {
    const profile = process.env.TAURI_NATIVE_VIDEO_PROFILE!;
    if (process.env.GDK_BACKEND !== "x11" || process.env.WAYLAND_DISPLAY ||
      !process.env.DISPLAY || !process.env.DBUS_SESSION_BUS_ADDRESS ||
      process.env.XDG_CONFIG_HOME !== path.join(profile, "config")) {
      throw new Error("Video qualification requires the owned private Xvfb/D-Bus/XDG profile");
    }
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(proof, { recursive: true });
    owner = await browser.getWindowHandle();
    directory = fs.realpathSync(createNativeFixtureDirectory("native-video-extra-"));
    colors = path.join(directory, "0-colors.webm");
    text = path.join(directory, "1-readme.txt");
    fs.copyFileSync(path.join(process.env.TAURI_NATIVE_VIDEO_FIXTURES!, "colors.webm"), colors);
    fs.writeFileSync(text, "A real non-video selection.\n");
    fs.writeFileSync(path.join(directory, "2-invalid.webm"), "not a video container");
    await browser.setWindowSize(1280, 900);
    await navigateTo(directory);
    await videoCommand("Details View");
  });

  beforeEach(async () => {
    await browser.switchToWindow(owner);
    await $(entryPathSelector(text)).click();
    await videoCommand("Reset Zoom");
    await videoCommand("Dock Preview Pane Right");
    await cleanup();
  });

  after(async () => {
    await browser.switchToWindow(owner);
    await browser.releaseActions();
    await $(entryPathSelector(text)).click();
    report("supplemental-cleanup.json", await cleanup());
  });

  it("a real invalid container reports failure and releases its native source", async () => {
    await $(entryPathSelector(path.join(directory, "2-invalid.webm"))).click();
    if (!await $(".preview-pane").isDisplayed()) await videoCommand("Toggle Preview Pane");
    await $(".video-message").waitForDisplayed();
    await browser.waitUntil(async () => /codec|format|unavailable|Cannot load/i.test(await $(".video-message").getText()));
    expect(await $('[aria-label="Play video"]').isEnabled()).toBe(false);
    await browser.saveScreenshot(path.join(proof, "native-invalid-container.png"));
    report("invalid-container.json", { message: await $(".video-message").getText(), stats: await cleanup() });
  });

  it("List and Tiles selections decode, seek and release the actual source", async () => {
    for (const view of ["List", "Tiles"]) {
      await videoCommand(`${view} View`);
      const initial = await select(colors);
      expect(await $(entryPathSelector(colors)).getAttribute("aria-selected")).toBe("true");
      await $('[aria-label="Play video"]').click();
      await browser.waitUntil(async () => {
        const state = await videoState();
        return !!state && !state.paused && state.currentTime > 0.15 && state.readyState >= 2;
      });
      await $('[aria-label="Pause video"]').click();
      const red = await screenshotPixels(path.join(proof, `native-${view.toLowerCase()}-red.png`));
      expect(red.rgb[0]).toBeGreaterThan(210);
      await seekBlue();
      const blue = await screenshotPixels(path.join(proof, `native-${view.toLowerCase()}-seek-blue.png`));
      expect(blue.rgb[2]).toBeGreaterThan(210);
      expect(blue.rgb[0]).toBeLessThan(40);
      await $(entryPathSelector(text)).click();
      await revoked(initial.src!);
      const sourceBytesPreserved = fs.readFileSync(colors).equals(
        fs.readFileSync(path.join(process.env.TAURI_NATIVE_VIDEO_FIXTURES!, "colors.webm")),
      );
      expect(sourceBytesPreserved).toBe(true);
      report(`native-${view.toLowerCase()}-outcomes.json`, { red, blue, cleanup: await cleanup(), sourceBytesPreserved });
    }
  });

  it("actual Ctrl+N activates the parked window and destruction revokes its playing source", async () => {
    await videoCommand("Details View");
    const parked = await parkedWarmWindow();
    expect(await windowOperation("target-state", parked.label)).toEqual({ exists: true, visible: false });
    const before = await cleanup();
    await browser.keys(["Control", "n"]);
    await browser.waitUntil(async () => {
      const state = await windowOperation("target-state", parked.label) as { exists: boolean; visible: boolean };
      return state.exists && state.visible;
    });
    await browser.switchToWindow(parked.handle);
    await browser.waitUntil(() => browser.execute(() => document.documentElement.dataset.e2eWindowLabel !== undefined));
    expect(await browser.execute(() => document.documentElement.dataset.e2eWindowLabel)).toBe(parked.label);
    await expect($(".status-path")).toHaveAttribute("title", directory);
    const inherited = await browser.execute(() =>
      Array.from(document.querySelectorAll('.entry-item[aria-selected="true"]')).map(element => element.getAttribute("data-path")));
    const selected = await select(colors);
    await seekBlue();
    const decoded = await childBlue(path.join(proof, "native-activated-warm-seek-blue.png"));
    await $('[aria-label="Play video"]').click();
    await browser.waitUntil(async () => {
      const state = await videoState();
      return !!state && !state.paused && state.currentTime > 4.1;
    });
    expect(mediaFileHandles(nativeFileIdentity(colors)).length).toBeGreaterThan(0);
    const playing = (await videoState())!;
    expect((await videoStats()).active_leases).toBe(1);

    // Close the actual native owner while it plays; the parent remains scriptable.
    await browser.switchToWindow(owner);
    await windowOperation("native-close", parked.label);
    await browser.waitUntil(async () => !(await windowOperation("target-state", parked.label) as { exists: boolean }).exists);
    await revoked(selected.src!);
    const settled = await cleanup();
    report("warm-activation-retirement.json", {
      parked, parentDirectory: directory, inheritedSelection: inherited, selectedPath: colors,
      decoded, playing, before, settled, windowDestroyed: true, oldCapabilityRevoked: true,
      oldFileHandles: mediaFileHandles(nativeFileIdentity(colors)),
    });
  });
});
