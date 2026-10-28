/**
 * Linux videos whose audio codec WebKitGTK cannot decode are audible (#1171).
 * Opt in on a host WITHOUT a GStreamer AAC decoder (no gst-libav), with ffmpeg on
 * PATH, an owned private Xvfb/D-Bus profile, and TAURI_NATIVE_VIDEO_AUDIO=1. Set
 * TAURI_NATIVE_AUDIO_MONITOR to a PulseAudio/PipeWire monitor source (for example
 * a null sink's `.monitor`) to assert what is actually heard, not just element state.
 */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createNativeFixtureDirectory } from "../native-qualification";
import { entryPathSelector, navigateTo } from "./helpers";
import { videoCommand, videoState, rangeKeys, revealVolume } from "../video-observations";

const enabled = process.platform === "linux" && process.env.TAURI_NATIVE_VIDEO_AUDIO === "1";
const monitor = process.env.TAURI_NATIVE_AUDIO_MONITOR;
const output = process.env.TAURI_NATIVE_VIDEO_ARTIFACT_DIR ?? "e2e-tauri/logs/video-companion-audio";
const report = (name: string, value: unknown) => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n"); };

/** RMS of what the monitor hears over `ms` (16 kHz mono; the default latency
 * buffers about a second, so a short low-latency window); null without a monitor. */
async function heard(ms = 2000): Promise<number | null> {
  if (!monitor) return null;
  const capture = path.join(output, `capture-${Date.now()}.raw`);
  const recorder = spawn("parecord", ["--raw", "--format=s16le", "--channels=1", "--rate=16000", "--latency-msec=100", "-d", monitor, capture], { stdio: ["ignore", "ignore", "pipe"] });
  const errors: string[] = [];
  recorder.stderr.on("data", chunk => errors.push(String(chunk)));
  await new Promise(resolve => setTimeout(resolve, ms));
  recorder.kill();
  const exit = await new Promise(resolve => recorder.once("close", (code, signal) => resolve(`${code}/${signal}`)));
  const pcm = fs.readFileSync(capture);
  fs.rmSync(capture);
  if (pcm.length < ms * 8) throw new Error(`audio monitor ${monitor} returned ${pcm.length} bytes (exit ${exit}, runtime ${process.env.XDG_RUNTIME_DIR}): ${errors.join("")}`);
  let sum = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) sum += pcm.readInt16LE(offset) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}
const AUDIBLE = 300;
const SILENT = 20;

function companion() {
  return browser.execute(() => {
    const audio = document.querySelector<HTMLAudioElement>(".video-preview audio");
    const video = document.querySelector<HTMLVideoElement>(".video-preview video") as (HTMLVideoElement & { audioTracks?: { length: number } }) | null;
    return { src: audio?.getAttribute("src") ?? null, paused: audio?.paused ?? null, currentTime: audio?.currentTime ?? null,
      volume: audio?.volume ?? null, muted: audio?.muted ?? null, readyState: audio?.readyState ?? null,
      nativeAudioTracks: video?.audioTracks?.length ?? null,
      note: document.querySelector(".video-preview .audio-note")?.textContent?.trim() ?? null,
      message: document.querySelector(".video-preview .video-message")?.textContent?.trim() ?? null };
  });
}
async function select(file: string) {
  await $(entryPathSelector(file)).click();
  if (!await $(".preview-pane").isDisplayed()) await videoCommand("Toggle Preview Pane");
  await $('[aria-label="Play video"]').waitForEnabled({ timeout: 20_000 });
}
async function play() {
  await $('[aria-label="Play video"]').click();
  await browser.waitUntil(async () => { const state = await videoState(); return !!state && !state.paused && state.currentTime > 0.5; }, { timeout: 15_000 });
}
async function pause() {
  if (await $('[aria-label="Pause video"]').isExisting()) await $('[aria-label="Pause video"]').click();
}

(enabled ? describe : describe.skip)("Linux companion audio for undecodable audio tracks (#1171)", function () {
  this.bail(true);
  let directory: string; let aac: string; let opus: string; let silent: string;
  before(async () => {
    if (process.env.GDK_BACKEND !== "x11" || process.env.WAYLAND_DISPLAY || !process.env.DBUS_SESSION_BUS_ADDRESS) throw new Error("Companion-audio qualification requires an owned private Xvfb/D-Bus session");
    fs.mkdirSync(output, { recursive: true });
    directory = fs.realpathSync(createNativeFixtureDirectory("native-video-audio-1171-"));
    aac = path.join(directory, "0-aac.mkv"); opus = path.join(directory, "1-opus.mkv"); silent = path.join(directory, "2-silent.webm");
    const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    const picture = ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30"];
    const tone = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"];
    ffmpeg(...picture, ...tone, "-t", "30", "-c:v", "libvpx", "-b:v", "300k", "-c:a", "aac", "-shortest", aac);
    ffmpeg("-i", aac, "-c:v", "copy", "-c:a", "libopus", opus);
    ffmpeg(...picture, "-t", "10", "-c:v", "libvpx", "-b:v", "300k", silent);
    await browser.setWindowSize(1280, 900);
    await navigateTo(directory);
    await videoCommand("Details View");
  });
  afterEach(async () => { await pause(); });

  it("an AAC track WebKitGTK cannot decode is heard, follows volume/mute, and survives fullscreen", async () => {
    await select(aac);
    const before = await companion();
    expect(before.nativeAudioTracks).toBe(0); // precondition: this host lacks a GStreamer AAC decoder
    await play();
    await browser.waitUntil(async () => { const state = await companion(); return !!state.src && state.paused === false && (state.currentTime ?? 0) > 0.3; },
      { timeout: 30_000, timeoutMsg: "companion audio never started" });
    const playing = await companion(); const video = (await videoState())!;
    expect(playing.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/media\/[a-f0-9]{48}$/);
    expect(playing.src).not.toBe(video.src);
    expect(Math.abs(playing.currentTime! - video.currentTime)).toBeLessThan(0.5);
    const audible = await heard();

    await $('[aria-label="Mute video"]').click();
    expect((await companion()).muted).toBe(true);
    const mutedLevel = await heard();
    await $('[aria-label="Unmute video"]').click();
    expect((await companion()).muted).toBe(false);
    await revealVolume();
    await rangeKeys('[aria-label="Video volume"]', 5); // Home, then a few steps up
    const lowered = (await videoState())!.volume;
    expect(lowered).toBeGreaterThan(0);
    expect(lowered).toBeLessThan(0.5);
    expect((await companion()).volume).toBeCloseTo(lowered, 2);
    const quieter = await heard();
    await rangeKeys('[aria-label="Video volume"]', 20);
    expect((await videoState())!.volume).toBe(1);
    expect((await companion()).volume).toBeCloseTo(1, 2);

    await $('[aria-label="View video fullscreen"]').click();
    await $(".preview-pane.fullscreen").waitForDisplayed();
    expect((await companion()).paused).toBe(false);
    const fullscreen = await heard();
    await browser.saveScreenshot(path.join(output, "aac-fullscreen-playing.png"));
    await browser.keys("Escape");
    await $(".preview-pane.fullscreen").waitForExist({ reverse: true });

    await $('[aria-label="Pause video"]').click();
    await browser.waitUntil(async () => (await companion()).paused === true);
    const paused = await heard();
    report("aac.json", { before, playing, video, audible, mutedLevel, quieter, fullscreen, paused });
    if (monitor) {
      expect(audible!).toBeGreaterThan(AUDIBLE);
      expect(mutedLevel!).toBeLessThan(SILENT);
      expect(quieter!).toBeGreaterThan(SILENT);
      expect(quieter!).toBeLessThan(audible! * 0.5);
      expect(fullscreen!).toBeGreaterThan(AUDIBLE);
      expect(paused!).toBeLessThan(SILENT);
    }
  });

  it("an audio track WebKitGTK decodes natively gets no companion", async () => {
    await select(opus);
    await play();
    await browser.pause(1000);
    const state = await companion();
    const audible = await heard();
    report("opus.json", { state, audible });
    expect(state.nativeAudioTracks).toBe(1);
    expect(state.src).toBeNull();
    expect(state.note).toBeNull();
    if (monitor) expect(audible!).toBeGreaterThan(AUDIBLE);
  });

  it("a video without audio plays without an error or audio notice", async () => {
    await select(silent);
    await play();
    await browser.pause(2000);
    const state = await companion();
    report("silent.json", { state, video: await videoState() });
    expect(state.src).toBeNull();
    expect(state.note).toBeNull();
    expect(state.message).toBeNull();
    expect((await videoState())!.errorCode).toBeNull();
  });
});
