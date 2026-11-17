/**
 * On-demand hosted-Mac visual capture (#1750).
 *
 * Seeds settings per scenario, launches the production `.app` through Appium
 * Mac2/XCTest, and captures window stills plus screen recordings of tab
 * opening, switching, closing and overflow. ffmpeg cuts each recording into
 * per-frame PNGs of the title/tab strip; Pillow builds contact sheets.
 *
 * This is evidence, not a test: it asserts nothing about the product. It must
 * tolerate branches that predate newer settings (unknown keys are simply
 * ignored by the app) and keeps capturing after a failed step. It exits
 * non-zero only when the capture machinery itself failed, so a red run means
 * "the images are missing or unusable", never "the UI regressed".
 *
 * It changes the desktop wallpaper, wipes the app's config and WebKit storage
 * and launches GUI input, so it refuses to run outside a disposable
 * GitHub-hosted runner.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remote, type Browser } from "webdriverio";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUTPUT = path.resolve(process.env.CAPTURE_OUTPUT ?? "qualification-results/macos-visual-capture");
const APP = path.resolve(process.env.CAPTURE_APP ?? "src-tauri/target/release/bundle/macos/tauri-explorer.app");
const PYTHON = process.env.CAPTURE_PYTHON ?? "python3";
const BUNDLE_ID = "io.github.xnmp.tauri-explorer";
const PROCESS_NAME = "tauri-explorer";
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, "Library/Application Support/tauri-explorer");
const FIXTURE = path.join(HOME, "Visual Capture Demo");
const READY_MARKER = "visual-capture-ready.txt";

// XCUIKeyModifierFlags, as used by Mac2's `macos: keys`.
const SHIFT = 1 << 1;
const CONTROL = 1 << 2;
const COMMAND = 1 << 4;

interface Rect { x: number; y: number; width: number; height: number }
interface Display extends Rect { id: number; pixelWidth: number; pixelHeight: number }
type ImageStats = { path: string; width: number; height: number; mean: number; stddev: number; blank: boolean };
type RecorderKind = "screencapture" | "ffmpeg" | "burst";
interface RecorderChoice { kind: RecorderKind; stop: "signal" | "duration"; screenDevice?: string }

interface Scenario {
  id: string;
  title: string;
  settings: Record<string, unknown>;
  record?: boolean;
  settingsDialog?: boolean;
}

// Shared by every scenario. integratedTitleBar puts the tabs in the title bar
// beside the traffic lights, where the island tab-to-panel seam is drawn;
// scenario f keeps the native title bar for comparison. Keys a branch does
// not know are ignored by its settings merge.
const BASE = {
  macOsVibrancy: true,
  vibrancyBlur: true,
  integratedTitleBar: true,
  warmWindow: false,
  autoUpdate: false,
  showPreviewPane: false,
  viewMode: "details",
};
const ISLANDS = { layoutTheme: "floating-islands", floatingIslands: true };
const DEFAULT_LAYOUT = { layoutTheme: "default", floatingIslands: false };

const SCENARIOS: Scenario[] = [
  { id: "a-islands-dark", title: "Floating Islands + Native Blur, dark", settings: { ...BASE, ...ISLANDS, theme: "dark" }, record: true },
  { id: "b-islands-light", title: "Floating Islands + Native Blur, light", settings: { ...BASE, ...ISLANDS, theme: "light" }, record: true },
  { id: "c-default-dark", title: "Default layout + Native Blur, dark", settings: { ...BASE, ...DEFAULT_LAYOUT, theme: "dark" }, record: true },
  { id: "d1-islands-dark-opacity-20", title: "Floating Islands, dark, translucencyOpacity 20", settings: { ...BASE, ...ISLANDS, theme: "dark", translucencyOpacity: 20 } },
  { id: "d2-islands-dark-opacity-100", title: "Floating Islands, dark, translucencyOpacity 100", settings: { ...BASE, ...ISLANDS, theme: "dark", translucencyOpacity: 100 } },
  { id: "e-settings-translucency", title: "Settings dialog filtered to the vibrancy rows", settings: { ...BASE, ...ISLANDS, theme: "dark" }, settingsDialog: true },
  { id: "f-islands-dark-native-titlebar", title: "Floating Islands, dark, native title bar", settings: { ...BASE, ...ISLANDS, theme: "dark", integratedTitleBar: false } },
];

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  finishedAt: "",
  app: APP,
  sourceRef: process.env.CAPTURE_REF ?? null,
  sourceCommit: process.env.CAPTURE_COMMIT ?? null,
  host: {} as Record<string, unknown>,
  display: null as Display | null,
  wallpaper: null as unknown,
  recorder: { choice: null as RecorderChoice | null, probes: [] as unknown[] },
  scenarios: [] as unknown[],
  notes: [] as string[],
  errors: [] as string[],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rel = (file: string) => path.relative(OUTPUT, file);

function run(command: string, args: string[], timeout = 60_000): string {
  return execFileSync(command, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
}

function attempt<T>(label: string, operation: () => T): T | null {
  try { return operation(); } catch (error) {
    report.notes.push(`${label}: ${String(error).slice(0, 400)}`);
    return null;
  }
}

function python<T>(...args: string[]): T {
  return JSON.parse(run(PYTHON, [path.join(HERE, "macos_visual_capture.py"), ...args], 600_000)) as T;
}

function saveReport(): void {
  fs.writeFileSync(path.join(OUTPUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

// ---------------------------------------------------------------- host setup

let helper = "";

function prepareHost(): void {
  helper = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "visual-capture-")), "capture-helper");
  run("swiftc", ["-O", path.join(HERE, "macos-visual-capture.swift"), "-o", helper], 300_000);
  report.host.swVers = attempt("sw_vers", () => run("sw_vers", []).trim());
  report.host.model = attempt("hw.model", () => run("sysctl", ["-n", "hw.model"]).trim());
  report.host.ffmpeg = attempt("ffmpeg -version", () => run("ffmpeg", ["-version"]).split("\n")[0]);
  report.display = JSON.parse(run("swift", [path.join(HERE, "macos-display.swift")], 300_000)) as Display;

  const display = report.display!;
  const wallpaper = path.join(OUTPUT, "wallpaper.png");
  python("wallpaper", wallpaper, String(display.pixelWidth), String(display.pixelHeight));
  report.wallpaper = attempt("set wallpaper", () => JSON.parse(run(helper, ["wallpaper", wallpaper])));
  report.host.accessibility = attempt("display accommodations", () => JSON.parse(run(helper, ["a11y", "-"])));
  if ((report.host.accessibility as { reduceTransparency?: boolean } | null)?.reduceTransparency) {
    report.notes.push("Reduce Transparency is on: macOS paints materials opaque and the page sees prefers-reduced-transparency");
  }
}

async function captureDesktop(): Promise<void> {
  // WallpaperAgent applies the picture asynchronously.
  await sleep(4_000);
  const desktop = path.join(OUTPUT, "desktop.png");
  attempt("desktop screencapture", () => run("screencapture", ["-x", desktop]));
  if (fs.existsSync(desktop)) report.host.desktop = python<ImageStats>("stats", desktop);
}

// ----------------------------------------------------------------- app state

function quitApp(): void {
  try { execFileSync("pkill", ["-x", PROCESS_NAME]); } catch { /* not running */ }
}

async function waitForAppExit(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try { execFileSync("pgrep", ["-x", PROCESS_NAME]); } catch { return; }
    await sleep(250);
  }
  try { execFileSync("pkill", ["-9", "-x", PROCESS_NAME]); } catch { /* gone */ }
}

/** Each scenario starts from a fresh profile: no restored tabs or cached settings. */
function resetAppState(settings: Record<string, unknown>): void {
  for (const dir of [
    CONFIG_DIR,
    path.join(HOME, "Library/WebKit", BUNDLE_ID),
    path.join(HOME, "Library/WebKit", PROCESS_NAME),
    path.join(HOME, "Library/Caches", BUNDLE_ID),
    path.join(HOME, "Library/Caches", PROCESS_NAME),
    path.join(HOME, "Library/Application Support", BUNDLE_ID),
    path.join(HOME, "Library/Saved Application State", `${BUNDLE_ID}.savedState`),
  ]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function prepareFixture(): void {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  for (const dir of ["Archive", "Design", "Documents", "Music", "Photos", "Projects", "Screenshots"]) {
    fs.mkdirSync(path.join(FIXTURE, dir), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE, dir, "notes.txt"), `${dir}\n`);
  }
  const files: Record<string, string> = {
    [READY_MARKER]: "capture fixture\n",
    "README.md": "# Visual capture\n\nFixture for the hosted Mac capture.\n",
    "budget-2026.csv": "month,amount\nJan,10\nFeb,20\n",
    "roadmap.md": "- islands\n- vibrancy\n- translucency\n",
    "palette.json": "{\"accent\":\"#ff3366\"}\n",
    "release-notes.txt": "Floating Islands polish\n",
    "build.log": "ok\n".repeat(200),
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(FIXTURE, name), body);
}

// ------------------------------------------------------------ Mac2 helpers

async function openSession(): Promise<Browser> {
  const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: "mac",
    "appium:automationName": "mac2",
    "appium:bundleId": BUNDLE_ID,
    "appium:appPath": APP,
    "appium:arguments": [FIXTURE],
    "appium:showServerLogs": true,
  };
  return remote({ hostname: "127.0.0.1", port: 4723, path: "/", logLevel: "warn", capabilities });
}

async function key(browser: Browser, name: string, modifierFlags = 0): Promise<void> {
  await browser.execute("macos: keys", { keys: [{ key: name, modifierFlags }] });
}

async function rectOf(element: WebdriverIO.Element): Promise<Rect> {
  return { ...await element.getLocation(), ...await element.getSize() };
}

async function windowRect(browser: Browser): Promise<Rect> {
  const window = await browser.$("-ios predicate string:elementType == 4").getElement();
  await window.waitForExist({ timeout: 30_000 });
  return rectOf(window);
}

interface TabInfo { element: WebdriverIO.Element; rect: Rect }

/** Tabs label themselves "<title> — <tooltip>" (WindowTabBar.svelte). */
async function tabs(browser: Browser, window: Rect): Promise<TabInfo[]> {
  const elements = await browser.$$("-ios predicate string:elementType != 4 AND label CONTAINS '—'");
  const found: TabInfo[] = [];
  for (const element of elements) {
    const rect = await rectOf(element);
    if (rect.y < window.y + 160 && rect.width < window.width / 2 && rect.height < 80) found.push({ element, rect });
  }
  return found.sort((a, b) => a.rect.x - b.rect.x);
}

async function tabCount(browser: Browser): Promise<number> {
  return (await browser.$$("-ios predicate string:elementType != 4 AND label CONTAINS '—'")).length;
}

function windowId(): number | null {
  const pid = attempt("pgrep app", () => run("pgrep", ["-n", "-x", PROCESS_NAME]).trim());
  if (!pid) return null;
  const windows = JSON.parse(run(helper, ["windows", pid])) as Array<{ id: number; layer: number; onscreen: boolean; width: number; height: number }>;
  const visible = windows.filter((w) => w.layer === 0 && w.onscreen && w.width > 200 && w.height > 200)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  return visible[0]?.id ?? null;
}

// ------------------------------------------------------------------- stills

interface ScenarioContext {
  scenario: Scenario;
  browser: Browser;
  dir: string;
  window: Rect;
  stripHeight: number;
  stills: Record<string, Record<string, ImageStats | string>>;
  recordings: unknown[];
  observations: Record<string, unknown>;
}

/**
 * Three views of one moment: screencapture's window-only image (-l, no
 * shadow), the screen region under the window (what a user sees, material
 * included), and XCTest's own screenshot cropped to the window — the route
 * the native UI smoke already proves, kept as a fallback.
 */
async function still(ctx: ScenarioContext, name: string): Promise<void> {
  const display = report.display!;
  const scale = display.pixelWidth / display.width;
  const w = ctx.window;
  const results: Record<string, ImageStats | string> = {};
  const id = windowId();
  if (id !== null) {
    const file = path.join(ctx.dir, `${name}-window.png`);
    attempt(`${ctx.scenario.id} ${name} window capture`, () => run("screencapture", ["-x", "-o", "-l", String(id), file]));
    if (fs.existsSync(file)) results.window = python<ImageStats>("stats", file);
  } else results.window = "no on-screen window id";
  const region = path.join(ctx.dir, `${name}-region.png`);
  attempt(`${ctx.scenario.id} ${name} region capture`, () =>
    run("screencapture", ["-x", "-R", `${w.x},${w.y},${w.width},${w.height}`, region]));
  if (fs.existsSync(region)) results.region = python<ImageStats>("stats", region);
  try {
    const screen = path.join(ctx.dir, `${name}-xctest-screen.png`);
    await ctx.browser.saveScreenshot(screen);
    const crop = path.join(ctx.dir, `${name}-xctest.png`);
    python("crop", screen, crop, String((w.x - display.x) * scale), String((w.y - display.y) * scale),
      String(w.width * scale), String(w.height * scale));
    results.xctest = python<ImageStats>("stats", crop);
    fs.rmSync(screen);
  } catch (error) { results.xctest = `failed: ${String(error).slice(0, 300)}`; }
  ctx.stills[name] = results;
  saveReport();
}

// --------------------------------------------------------------- recorders

function spawnRecorder(choice: RecorderChoice, file: string, region: Rect, seconds: number): ChildProcess {
  if (choice.kind === "screencapture") {
    return spawn("screencapture", ["-x", "-v", "-V", String(seconds), "-R",
      `${region.x},${region.y},${region.width},${region.height}`, file], { stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn("ffmpeg", ["-y", "-v", "error", "-f", "avfoundation", "-capture_cursor", "1", "-framerate", "30",
    "-i", `${choice.screenDevice}:none`, "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "pipe", "pipe"] });
}

function exited(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

async function stopRecorder(child: ChildProcess, choice: RecorderChoice, budget: number): Promise<void> {
  if (choice.stop === "duration") {
    if (await exited(child, budget)) return;
  } else if (choice.kind === "ffmpeg") {
    child.stdin?.write("q");
    if (await exited(child, 10_000)) return;
  } else {
    child.kill("SIGINT");
    if (await exited(child, 15_000)) return;
  }
  child.kill("SIGTERM");
  if (!await exited(child, 5_000)) child.kill("SIGKILL");
}

interface VideoInfo { width: number; height: number; frames: number; middle: ImageStats | null }

function inspectVideo(file: string): VideoInfo | null {
  if (!fs.existsSync(file) || fs.statSync(file).size < 1_000) return null;
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", file])) as
    { streams?: Array<{ width: number; height: number; nb_read_frames: string }> };
  const stream = probe.streams?.[0];
  if (!stream) return null;
  const frames = Number(stream.nb_read_frames);
  let middle: ImageStats | null = null;
  if (frames > 0) {
    const png = `${file}.middle.png`;
    attempt("middle frame", () => run("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf",
      `select=eq(n\\,${Math.floor(frames / 2)})`, "-frames:v", "1", png]));
    if (fs.existsSync(png)) { middle = python<ImageStats>("stats", png); fs.rmSync(png); }
  }
  return { width: stream.width, height: stream.height, frames, middle };
}

const usable = (video: VideoInfo | null) => !!video && video.frames > 2 && !!video.middle && !video.middle.blank;

/** Find a recorder that produces non-blank frames on this runner. */
async function chooseRecorder(region: Rect): Promise<RecorderChoice> {
  const dir = path.join(OUTPUT, "recorder-probe");
  fs.mkdirSync(dir, { recursive: true });
  const probe = async (choice: RecorderChoice, name: string, seconds: number, stopAfter: number | null) => {
    const file = path.join(dir, name);
    const started = Date.now();
    const child = spawnRecorder(choice, file, region, seconds);
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += String(error); });
    if (stopAfter !== null) { await sleep(stopAfter); await stopRecorder(child, choice, 0); }
    else await stopRecorder(child, { ...choice, stop: "duration" }, (seconds + 20) * 1000);
    const video = attempt(`inspect ${name}`, () => inspectVideo(file));
    report.recorder.probes.push({ name, choice, ms: Date.now() - started, exit: child.exitCode, signal: child.signalCode,
      stderr: stderr.slice(0, 500), video, usable: usable(video) });
    saveReport();
    return usable(video);
  };
  const screencapture: RecorderChoice = { kind: "screencapture", stop: "signal" };
  if (await probe(screencapture, "screencapture-signal.mov", 60, 3_000)) return screencapture;
  if (await probe({ ...screencapture, stop: "duration" }, "screencapture-duration.mov", 3, null)) {
    return { ...screencapture, stop: "duration" };
  }
  const devices = attempt("avfoundation devices", () => {
    try { return run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]); }
    catch (error) { return String((error as { stderr?: string }).stderr ?? error); }
  }) ?? "";
  report.recorder.probes.push({ avfoundationDevices: devices.slice(0, 2000) });
  const screenDevice = /\[(\d+)\] Capture screen 0/.exec(devices)?.[1];
  if (screenDevice !== undefined) {
    const ffmpeg: RecorderChoice = { kind: "ffmpeg", stop: "signal", screenDevice };
    if (await probe(ffmpeg, "ffmpeg-avfoundation.mp4", 60, 3_000)) return ffmpeg;
  }
  report.notes.push("no video recorder produced usable frames; falling back to a screencapture still burst");
  return { kind: "burst", stop: "signal" };
}

// --------------------------------------------------------------- recordings

type Mark = (label: string) => void;

async function recordAction(ctx: ScenarioContext, name: string, plannedSeconds: number,
  action: (mark: Mark) => Promise<void>): Promise<void> {
  const choice = report.recorder.choice!;
  const dir = path.join(ctx.dir, "recordings");
  const framesDir = path.join(dir, `${name}-frames`);
  const sheetsDir = path.join(dir, `${name}-sheets`);
  fs.mkdirSync(framesDir, { recursive: true });
  const display = report.display!;
  const region = ctx.window;
  const strip: Rect = { ...region, height: Math.min(region.height, ctx.stripHeight) };
  const result: Record<string, unknown> = { name, recorder: choice.kind, marks: [] as unknown[] };
  ctx.recordings.push(result);
  const marks = result.marks as Array<{ label: string; t: number }>;
  const started = Date.now();
  const mark: Mark = (label) => marks.push({ label, t: (Date.now() - started) / 1000 });
  const tabsBefore = await tabCount(ctx.browser);

  let file: string | null = null;
  let child: ChildProcess | null = null;
  let burst: Promise<void> | null = null;
  let stopBurst = false;
  if (choice.kind === "burst") {
    const times: number[] = [];
    burst = (async () => {
      for (let n = 1; !stopBurst && n < 2_000; n++) {
        const frame = path.join(framesDir, `${String(n).padStart(5, "0")}.png`);
        await new Promise<void>((resolve) => {
          spawn("screencapture", ["-x", "-R", `${strip.x},${strip.y},${strip.width},${strip.height}`, frame])
            .once("exit", () => resolve()).once("error", () => resolve());
        });
        times.push((Date.now() - started) / 1000);
      }
      fs.writeFileSync(path.join(framesDir, "times.txt"), `${times.join("\n")}\n`);
    })();
  } else {
    file = path.join(dir, `${name}.${choice.kind === "ffmpeg" ? "mp4" : "mov"}`);
    child = spawnRecorder(choice, file, region, choice.stop === "duration" ? plannedSeconds + 4 : 180);
  }
  await sleep(1_500);
  try { await action(mark); } catch (error) {
    report.errors.push(`${ctx.scenario.id} ${name}: ${String(error).slice(0, 400)}`);
  }
  await sleep(1_500);
  if (child) await stopRecorder(child, choice, (plannedSeconds + 30) * 1000);
  stopBurst = true;
  if (burst) await burst;
  result.durationSeconds = (Date.now() - started) / 1000;
  result.tabs = { before: tabsBefore, after: await tabCount(ctx.browser).catch(() => null) };

  if (file) {
    result.video = rel(file);
    const video = attempt(`${name} inspect`, () => inspectVideo(file!));
    result.videoInfo = video;
    if (!usable(video)) {
      report.errors.push(`${ctx.scenario.id} ${name}: recording has no usable frames`);
      saveReport();
      return;
    }
    // A region recording matches the window's aspect; otherwise it is the
    // whole display and the strip sits at the window's offset.
    const regionAspect = region.width / region.height;
    const isRegion = Math.abs(video!.width / video!.height - regionAspect) < 0.03;
    const scale = isRegion ? video!.width / region.width : video!.width / display.width;
    const crop = {
      x: isRegion ? 0 : Math.round((region.x - display.x) * scale),
      y: isRegion ? 0 : Math.round((region.y - display.y) * scale),
      width: Math.round(strip.width * scale),
      height: Math.round(strip.height * scale),
    };
    result.crop = { ...crop, isRegion, scale };
    run("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
      "-fps_mode", "passthrough", path.join(framesDir, "%05d.png")], 600_000);
    const times = attempt(`${name} frame times`, () => run("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "frame=pts_time", "-of", "csv=p=0", file!], 120_000));
    if (times) fs.writeFileSync(path.join(framesDir, "times.txt"), times);
  }
  result.sheets = attempt(`${name} contact sheets`, () => python("sheets", framesDir, sheetsDir));
  saveReport();
}

async function clickTab(ctx: ScenarioContext, index: number | "middle", mark: Mark): Promise<void> {
  const list = await tabs(ctx.browser, ctx.window);
  if (list.length === 0) { report.notes.push(`${ctx.scenario.id}: no tab elements to click`); return; }
  const target = index === "middle" ? Math.floor(list.length / 2) : Math.min(index, list.length - 1);
  mark(`click tab ${target + 1}/${list.length}`);
  await list[target].element.click();
  await parkPointer(ctx);
}

/** Move the pointer off the strip so hover styles and tooltips stay out of the frames. */
async function parkPointer(ctx: ScenarioContext): Promise<void> {
  const w = ctx.window;
  await ctx.browser.execute("macos: hover", { x: Math.round(w.x + w.width * 0.6), y: Math.round(w.y + w.height * 0.85) })
    .catch((error: unknown) => { report.notes.push(`pointer park failed: ${String(error).slice(0, 200)}`); });
}

async function recordTabActions(ctx: ScenarioContext): Promise<void> {
  const b = ctx.browser;
  await recordAction(ctx, "1-open-tabs", 8, async (mark) => {
    for (let i = 1; i <= 3; i++) { mark(`Cmd+T #${i}`); await key(b, "t", COMMAND); await sleep(1_600); }
  });
  await recordAction(ctx, "2-switch-tabs", 14, async (mark) => {
    mark("Ctrl+Tab"); await key(b, "XCUIKeyboardKeyTab", CONTROL); await sleep(1_300);
    mark("Ctrl+Tab"); await key(b, "XCUIKeyboardKeyTab", CONTROL); await sleep(1_300);
    mark("Ctrl+Shift+Tab"); await key(b, "XCUIKeyboardKeyTab", CONTROL | SHIFT); await sleep(1_300);
    mark("Cmd+Shift+]"); await key(b, "]", COMMAND | SHIFT); await sleep(1_300);
    await clickTab(ctx, 0, mark); await sleep(1_300);
    await clickTab(ctx, 2, mark); await sleep(1_300);
  });
  await recordAction(ctx, "3-close-middle-tab", 8, async (mark) => {
    await clickTab(ctx, "middle", mark); await sleep(1_300);
    mark("Cmd+W"); await key(b, "w", COMMAND); await sleep(1_800);
  });
  const toOpen = Math.max(0, 12 - await tabCount(b));
  await recordAction(ctx, "4-crowd-overflow", 6 + toOpen * 0.9 + 5 * 1.1, async (mark) => {
    for (let i = 1; i <= toOpen; i++) { mark(`Cmd+T crowd #${i}`); await key(b, "t", COMMAND); await sleep(700); }
    await sleep(1_500);
    for (let i = 1; i <= 5; i++) { mark(`Cmd+W crowd #${i}`); await key(b, "w", COMMAND); await sleep(900); }
  });
}

async function settingsDialog(ctx: ScenarioContext): Promise<void> {
  const b = ctx.browser;
  await key(b, "p", COMMAND | SHIFT);
  const palette = await b.$("-ios predicate string:placeholderValue == 'Type a command...'");
  await palette.waitForDisplayed({ timeout: 15_000 });
  await b.execute("macos: keys", { keys: Array.from("Settings"), elementId: palette.elementId });
  await sleep(800);
  await key(b, "XCUIKeyboardKeyReturn");
  const filter = await b.$("-ios predicate string:placeholderValue == 'Filter settings...'");
  await filter.waitForDisplayed({ timeout: 15_000 });
  await sleep(1_200);
  await still(ctx, "02-settings-dialog");
  // Search terms differ per row: "vibrancy" finds Window Vibrancy (and
  // Translucency Opacity where the ref has it), "blur" finds Native Blur
  // (and Translucency Opacity).
  let translucencyRow = false;
  for (const [index, query] of ["vibrancy", "blur"].entries()) {
    await b.execute("macos: keys", { keys: [{ key: "a", modifierFlags: COMMAND }], elementId: filter.elementId });
    await b.execute("macos: keys", { keys: Array.from(query), elementId: filter.elementId });
    await sleep(1_200);
    await still(ctx, `0${index + 3}-settings-filter-${query}`);
    const source = await b.getPageSource();
    fs.writeFileSync(path.join(ctx.dir, `settings-filter-${query}-page-source.xml`), source);
    translucencyRow ||= source.includes("Translucency Opacity");
  }
  ctx.observations.translucencyOpacityRow = translucencyRow;
  if (!ctx.observations.translucencyOpacityRow) {
    report.notes.push(`${ctx.scenario.id}: no Translucency Opacity row on this ref (captured anyway)`);
  }
}

async function runScenario(scenario: Scenario): Promise<void> {
  const dir = path.join(OUTPUT, "scenarios", scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  quitApp();
  await waitForAppExit();
  resetAppState(scenario.settings);
  fs.writeFileSync(path.join(dir, "settings.json"), `${JSON.stringify(scenario.settings, null, 2)}\n`);
  const entry = { id: scenario.id, title: scenario.title, stills: {}, recordings: [] as unknown[], observations: {}, error: null as string | null };
  report.scenarios.push(entry);
  let browser: Browser | undefined;
  try {
    browser = await openSession();
    await browser.waitUntil(async () => (await browser!.getPageSource()).includes(READY_MARKER), {
      timeout: 90_000, interval: 1_000, timeoutMsg: "app did not list the capture fixture",
    });
    // Let the material, fonts and first-paint transitions settle.
    await sleep(2_500);
    const ctx: ScenarioContext = {
      scenario, browser, dir, window: await windowRect(browser), stripHeight: 140,
      stills: entry.stills, recordings: entry.recordings, observations: entry.observations,
    };
    ctx.observations.window = ctx.window;
    await still(ctx, "01-single-tab");
    if (scenario.settingsDialog) { await settingsDialog(ctx); return; }

    await key(browser, "t", COMMAND); await sleep(1_000);
    await key(browser, "t", COMMAND); await sleep(1_000);
    await clickTab(ctx, 1, () => {}); await sleep(1_500);
    const tablist = await browser.$("-ios predicate string:label == 'Tabs'").getElement();
    if (await tablist.isExisting()) {
      const rect = await rectOf(tablist);
      ctx.observations.tablist = rect;
      // Include a band of the panel below so the tab-to-panel seam is visible.
      ctx.stripHeight = Math.max(60, Math.min(240, Math.round(rect.y + rect.height - ctx.window.y + 40)));
    } else report.notes.push(`${scenario.id}: tablist not found; strip crop uses ${ctx.stripHeight}pt`);
    ctx.observations.stripHeight = ctx.stripHeight;
    ctx.observations.tabsAfterSetup = await tabCount(browser);
    await still(ctx, "02-three-tabs-middle-active");
    if (scenario.record) {
      await recordTabActions(ctx);
      await still(ctx, "03-after-recordings");
    }
  } catch (error) {
    entry.error = String(error).slice(0, 800);
    report.errors.push(`${scenario.id}: ${entry.error}`);
    if (browser) {
      try { await browser.saveScreenshot(path.join(dir, "failure.png")); } catch { /* session gone */ }
      try { fs.writeFileSync(path.join(dir, "failure-page-source.xml"), await browser.getPageSource()); } catch { /* session gone */ }
    }
  } finally {
    if (browser) { try { await browser.deleteSession(); } catch { /* app may already be gone */ } }
    saveReport();
  }
}

// ------------------------------------------------------------------- README

function writeReadme(): void {
  const lines = [
    "macOS visual capture (#1750)",
    "",
    `Ref: ${report.sourceRef ?? "?"}  commit: ${report.sourceCommit ?? "?"}`,
    `Host: ${String(report.host.swVers ?? "").replace(/\n/g, "; ")}  model: ${String(report.host.model ?? "")}`,
    `Display: ${report.display ? `${report.display.width}x${report.display.height}pt, ${report.display.pixelWidth}x${report.display.pixelHeight}px` : "?"}`,
    `Recorder: ${report.recorder.choice ? JSON.stringify(report.recorder.choice) : "none"}`,
    `Display accommodations: ${JSON.stringify(report.host.accessibility ?? null)}`,
    "",
    "Layout",
    "  report.json            machine-readable run record: stills with blank checks, recordings, notes, errors",
    "  host.txt               runner, sw_vers, Xcode, TCC rows (written by the workflow)",
    "  wallpaper.png          generated high-contrast wallpaper; desktop.png shows it applied",
    "  recorder-probe/        short probe recordings used to pick a working recorder",
    "  appium.log             Appium/Mac2 server log",
    "  scenarios/<id>/settings.json      settings seeded before launch (unknown keys are ignored by older refs)",
    "  scenarios/<id>/NN-<moment>-window.png   screencapture -l: window only, no shadow",
    "  scenarios/<id>/NN-<moment>-region.png   screencapture -R: the screen under the window (material as a user sees it)",
    "  scenarios/<id>/NN-<moment>-xctest.png   XCTest screenshot cropped to the window (fallback route)",
    "  scenarios/<id>/recordings/<action>.mov  screen recording of the window during one action",
    "  scenarios/<id>/recordings/<action>-frames/NNNNN.png  every recorded frame, cropped to the title/tab strip",
    "  scenarios/<id>/recordings/<action>-frames/times.txt  presentation time (s) of each frame",
    "  scenarios/<id>/recordings/<action>-sheets/overview-sheet.png  ~20 frames sampled across the action's motion",
    "  scenarios/<id>/recordings/<action>-sheets/burst-NN-sheet.png  consecutive frames of one burst of motion (one input)",
    "",
    "Scenarios",
    ...SCENARIOS.map((s) => `  ${s.id}: ${s.title}${s.record ? " (with recordings)" : ""}`),
    "",
    "Actions (recorded scenarios start with three tabs, the middle one active)",
    "  1-open-tabs         Cmd+T three times, 1.6 s apart",
    "  2-switch-tabs       Ctrl+Tab, Ctrl+Tab, Ctrl+Shift+Tab, Cmd+Shift+], click tab 1, click tab 3",
    "  (after every click the pointer is parked over the file list so hover/tooltips stay out of the strip)",
    "  3-close-middle-tab  click the middle tab, then Cmd+W",
    "  4-crowd-overflow    Cmd+T until 12 tabs, then Cmd+W five times",
    "  Each recording's input times (seconds from recorder start) are in report.json under marks.",
    "",
    "Files",
  ];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (name.endsWith("-frames")) {
          const count = fs.readdirSync(full).filter((f) => f.endsWith(".png")).length;
          lines.push(`  ${rel(full)}/  (${count} frame PNGs)`);
        } else walk(full);
      } else lines.push(`  ${rel(full)}  ${(stat.size / 1024).toFixed(0)} KiB`);
    }
  };
  walk(OUTPUT);
  if (report.notes.length) lines.push("", "Notes", ...report.notes.map((n) => `  - ${n}`));
  if (report.errors.length) lines.push("", "Errors", ...report.errors.map((e) => `  - ${e}`));
  fs.writeFileSync(path.join(OUTPUT, "README.txt"), `${lines.join("\n")}\n`);
}

// --------------------------------------------------------------------- main

function stillsSummary(): { usable: number; blank: number } {
  let usableCount = 0;
  let blank = 0;
  for (const scenario of report.scenarios as Array<{ stills: Record<string, Record<string, ImageStats | string>> }>) {
    for (const moment of Object.values(scenario.stills)) {
      const images = Object.values(moment).filter((v): v is ImageStats => typeof v === "object");
      if (images.some((image) => !image.blank)) usableCount++; else blank++;
    }
  }
  return { usable: usableCount, blank };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("visual capture changes the desktop and app profile; it runs only on a disposable hosted Mac runner");
  }
  if (!fs.existsSync(path.join(APP, "Contents/MacOS", PROCESS_NAME))) throw new Error(`no app bundle at ${APP}`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const only = process.env.CAPTURE_SCENARIOS?.split(",").map((s) => s.trim()).filter(Boolean);
  const scenarios = only?.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  try {
    prepareHost();
    prepareFixture();
    await captureDesktop();
    const display = report.display!;
    // Probe on a centred 1200x800 region, the app's default window size.
    const probeRegion = {
      x: Math.round(display.x + Math.max(0, (display.width - 1200) / 2)),
      y: Math.round(display.y + Math.max(0, (display.height - 800) / 2)),
      width: Math.min(1200, display.width), height: Math.min(800, display.height),
    };
    report.recorder.choice = await chooseRecorder(probeRegion);
    saveReport();
    for (const scenario of scenarios) await runScenario(scenario);
  } catch (error) {
    report.errors.push(`setup: ${String(error).slice(0, 800)}`);
  } finally {
    quitApp();
    report.finishedAt = new Date().toISOString();
    const summary = stillsSummary();
    report.host.stills = summary;
    if (summary.usable === 0) report.errors.push("no usable (non-blank) still was captured");
    saveReport();
    writeReadme();
  }
  if (report.errors.length) {
    throw new Error(`visual capture finished with ${report.errors.length} error(s):\n${report.errors.join("\n")}`);
  }
}

await main();
