import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createNativeFixtureDirectory } from "../native-qualification";
import { entryPathSelector, navigateTo } from "./helpers";

const linux = process.platform === "linux";
const supported = linux || process.platform === "win32";
const proof = "screenshots/fix/722-progress-bar-when-copying-images";
let scratch: string;
let source: string;
let png: Buffer;
let owner: ChildProcess | undefined;

async function stopOwner() {
  if (!owner || owner.exitCode !== null || owner.signalCode !== null) { owner = undefined; return; }
  const child = owner;
  owner = undefined;
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await stopped;
}

async function copyImage() {
  await stopOwner();
  if (linux) {
    owner = spawn("xclip", ["-quiet", "-selection", "clipboard", "-t", "image/png", "-i", source], { stdio: "ignore" });
    await browser.waitUntil(() => {
      try { return execFileSync("xclip", ["-o", "-selection", "clipboard", "-t", "image/png"]).equals(png); }
      catch { return false; }
    }, { timeoutMsg: "private X11 clipboard did not offer the source PNG" });
    const environment = fs.readFileSync(`/proc/${owner.pid}/environ`, "utf8");
    for (const key of ["DISPLAY", "GDK_BACKEND", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME"])
      expect(environment.split("\0")).toContain(`${key}=${process.env[key]}`);
    expect(environment.split("\0").some((entry) => entry.startsWith("WAYLAND_DISPLAY="))).toBe(false);
  } else {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $image = [System.Drawing.Image]::FromFile($env:EXPLORER_CLIPBOARD_FIXTURE)
      try { [System.Windows.Forms.Clipboard]::SetDataObject($image, $true) }
      finally { $image.Dispose() }
    `], { env: { ...process.env, EXPLORER_CLIPBOARD_FIXTURE: source } });
  }
}

async function mode(name: string) {
  await browser.keys(["Control", "Shift", "p"]);
  await $(".command-palette-dialog .search-input").setValue(`${name} View`);
  await $(".command-palette-dialog .command-item").click();
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

(supported ? describe : describe.skip)("native clipboard image progress (#722)", function () {
  this.bail(true);
  before(async () => {
    if (linux && (!process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.GDK_BACKEND !== "x11" || !process.env.DBUS_SESSION_BUS_ADDRESS))
      throw new Error("Use private Xvfb/X11, D-Bus and XDG profile for this clipboard fixture");
    if (!linux && !process.env.CI) throw new Error("Windows clipboard automation is restricted to a disposable hosted CI desktop");
    scratch = createNativeFixtureDirectory("clipboard-images-");
    source = path.join(scratch, "source.png");
    // A standard four-quadrant, 3-megapixel fixture. The external clipboard
    // helper owns its PNG/bitmap; Explorer still reads the real OS clipboard.
    const encoded = await browser.execute(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 2048; canvas.height = 1536;
      const context = canvas.getContext("2d")!;
      for (const [index, color] of ["#ff0000", "#00ff00", "#0000ff", "#ffff00"].entries()) {
        context.fillStyle = color;
        context.fillRect((index % 2) * 1024, Math.floor(index / 2) * 768, 1024, 768);
      }
      return canvas.toDataURL("image/png").split(",")[1];
    });
    png = Buffer.from(encoded, "base64");
    fs.writeFileSync(source, png);
    fs.mkdirSync(proof, { recursive: true });
  });
  afterEach(async () => {
    try { await $(".image-paste-bar").waitForExist({ reverse: true, timeout: 30_000 }); }
    finally { await stopOwner(); }
  });

  for (const view of ["Details", "List", "Tiles"]) for (const explicit of [false, true]) {
    it(`${view}: ${explicit ? "Paste Image" : "Paste"} reads the actual clipboard and displays usable output`, async () => {
      const directory = path.join(scratch, `${view}-${explicit ? "explicit" : "normal"}`);
      fs.mkdirSync(directory);
      const sentinel = path.join(directory, "existing.txt");
      fs.writeFileSync(sentinel, "existing file remains unchanged");
      await navigateTo(directory);
      await mode(view);
      if (!explicit) {
        await $(entryPathSelector(sentinel)).click();
        await browser.keys(["Control", "c"]);
        await $(".toast.clipboard").waitForDisplayed();
      }
      await copyImage();
      await browser.keys(explicit ? ["Control", "Shift", "v"] : ["Control", "v"]);
      const progress = $('.image-paste-bar[role="progressbar"]');
      await progress.waitForDisplayed({ timeout: 10_000 });
      expect(await progress.getAttribute("aria-valuenow")).toBeNull();
      expect(await $(".image-paste .destination").getAttribute("title")).toBe(directory);
      expect(fs.readdirSync(directory)).toEqual(["existing.txt"]);
      const name = `${view.toLowerCase()}-${explicit ? "explicit" : "normal"}`;
      await browser.saveScreenshot(`${proof}/${name}-pending-${process.platform}.png`);
      await progress.waitForExist({ reverse: true, timeout: 30_000 });
      const images = fs.readdirSync(directory).filter((entry) => entry.endsWith(".png"));
      expect(images).toHaveLength(1);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("existing file remains unchanged");
      expect(fs.readdirSync(directory)).toHaveLength(2);
      const imagePath = path.join(directory, images[0]);
      const saved = fs.readFileSync(imagePath);
      if (linux) expect(saved.equals(png)).toBe(true);
      const decoded = await browser.executeAsync((encoded: string, done: (result: unknown) => void) => {
        const image = new Image();
        image.onerror = () => done({ error: "saved PNG did not decode" });
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          done({ dimensions: [image.naturalWidth, image.naturalHeight], pixels: [[512, 384], [1536, 384], [512, 1152], [1536, 1152]].map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) });
        };
        image.src = `data:image/png;base64,${encoded}`;
      }, saved.toString("base64"));
      expect(decoded).toEqual({ dimensions: [2048, 1536], pixels: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]] });
      await $(entryPathSelector(imagePath)).waitForDisplayed();
      await $(entryPathSelector(imagePath)).click();
      if (!await $(".preview-pane").isDisplayed()) await browser.keys(" ");
      await $(".preview-image").waitForDisplayed();
      await browser.waitUntil(() => browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>(".preview-image");
        return image?.complete && image.naturalWidth === 2048 && image.naturalHeight === 1536;
      }), { timeoutMsg: "saved image did not decode at its source dimensions in the actual preview" });
      await browser.saveScreenshot(`${proof}/${name}-completed-${process.platform}.png`);
    });
  }

  it("navigation remains usable while image work completes in the original directory", async () => {
    const origin = path.join(scratch, "pending-origin");
    const other = path.join(scratch, "interactive-other");
    for (const directory of [origin, other]) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "proof.txt"), path.basename(directory));
    }
    await navigateTo(origin);
    await copyImage();
    await browser.keys(["Control", "Shift", "v"]);
    const progress = $(".image-paste-bar");
    await progress.waitForDisplayed();
    await navigateTo(other);
    await expect($(".status-path")).toHaveAttribute("title", other);
    await expect(progress).toBeDisplayed();
    await browser.saveScreenshot(`${proof}/navigation-during-paste-${process.platform}.png`);
    await progress.waitForExist({ reverse: true, timeout: 30_000 });
    expect(fs.readdirSync(other)).toEqual(["proof.txt"]);
    expect(fs.readdirSync(origin).filter((name) => name.endsWith(".png"))).toHaveLength(1);
    await expect($(".status-path")).toHaveAttribute("title", other);
    await expect($(entryPathSelector(path.join(other, "proof.txt")))).toBeDisplayed();
  });

  (linux ? it : it.skip)("a real refused write ends progress and reports failure without an image", async () => {
    const directory = path.join(scratch, "refused-write");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "existing.txt"), "keep this file");
    await navigateTo(directory);
    await copyImage();
    fs.chmodSync(directory, 0o500);
    try {
      await browser.keys(["Control", "Shift", "v"]);
      const progress = $(".image-paste-bar");
      await progress.waitForDisplayed();
      await progress.waitForExist({ reverse: true, timeout: 30_000 });
      await expect($(".toast.error")).toHaveText(expect.stringContaining("Failed to create image"));
      expect(fs.readdirSync(directory)).toEqual(["existing.txt"]);
      expect(fs.readFileSync(path.join(directory, "existing.txt"), "utf8")).toBe("keep this file");
      await browser.executeAsync((done: () => void) => {
        const toast = document.querySelector(".toast.error");
        Promise.all((toast?.getAnimations() ?? []).map((animation) => animation.finished.catch(() => {}))).then(done);
      });
      await browser.saveScreenshot(`${proof}/refused-write-linux.png`);
    } finally { fs.chmodSync(directory, 0o700); }
  });
});
