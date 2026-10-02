import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { domText, entryPathSelector, navigateTo } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";

const fixtures = fileURLToPath(new URL("../fixtures/image-crop/", import.meta.url));
const scratch = fs.realpathSync(createNativeFixtureDirectory("explorer-image-crop-"));
const screenshotRoot = process.env.IMAGE_CROP_SCREENSHOTS;
const slider = (edge: string) => $(`[role="slider"][aria-label="${edge} crop edge"]`);
const button = (name: string) => $(`button=${name}`);
const dialog = '[role="dialog"][aria-label="Crop image"]';

async function command(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed(); await input.setValue(label);
  await browser.waitUntil(async () => (await domText(".command-palette-dialog")).includes(label));
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}
async function screenshot(name: string): Promise<void> {
  if (!screenshotRoot) return;
  fs.mkdirSync(screenshotRoot, { recursive: true });
  await browser.saveScreenshot(path.join(screenshotRoot, `${name}.png`));
}
async function open(file: string): Promise<void> {
  await navigateTo(scratch);
  await $(entryPathSelector(file)).click();
  if (!await $(".preview-pane").isDisplayed()) {
    await browser.keys(" ");
    await $(".preview-pane").waitForDisplayed();
  }
  await button("Crop image…").click();
  await slider("Right").waitForDisplayed();
}
async function crop(left = 32, top = 24, right = 480, bottom = 360): Promise<void> {
  for (const [edge, position] of [["left", left], ["top", top], ["right", right], ["bottom", bottom]] as const) {
    await $(`input[aria-label="${edge} pixel position"]`).click();
    await browser.keys(["Control", "a"]);
    await browser.keys(String(position));
    await browser.keys("Tab");
    await expect(slider(edge[0].toUpperCase() + edge.slice(1))).toHaveAttribute("aria-valuenow", String(position));
  }
}
const dataUrl = (data: Buffer, extension: string) => `data:${({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif" } as Record<string, string>)[extension]};base64,${data.toString("base64")}`;
async function compare(original: Buffer, output: Buffer, extension: string, padded = false) {
  return browser.executeAsync(async (original: string, saved: string, padded: boolean, done: (result: unknown) => void) => {
    try {
      const load = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); return image; };
      const [source, result] = await Promise.all([load(original), load(saved)]);
      const canvas = document.createElement("canvas");
      canvas.width = result.naturalWidth; canvas.height = result.naturalHeight;
      const context = canvas.getContext("2d")!;
      if (padded) context.drawImage(source, 16, 16, 224, 224, 16, 16, 224, 224);
      else context.drawImage(source, 32, 24, 448, 336, 0, 0, 448, 336);
      const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(result, 0, 0);
      const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let maximumError = 0;
      // JPEG edges may change when the selected area is encoded as new blocks;
      // compare interior samples there, every pixel in the lossless formats.
      for (let i = 0; i < actual.length; i++) maximumError = Math.max(maximumError, Math.abs(actual[i] - expected[i]));
      const samples = [[40, 40], [canvas.width - 40, 40], [40, canvas.height - 40], [canvas.width - 40, canvas.height - 40]];
      let interiorError = 0;
      for (const [x, y] of samples) for (let c = 0; c < 3; c++) {
        const index = (y * canvas.width + x) * 4 + c;
        interiorError = Math.max(interiorError, Math.abs(actual[index] - expected[index]));
      }
      let edgeDisplacement = 0;
      const darkBounds = (data: Uint8ClampedArray, y: number) => {
        const positions: number[] = [];
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (Math.max(data[i], data[i + 1], data[i + 2]) < 40) positions.push(x);
        }
        return [positions[0] ?? -1, positions.at(-1) ?? -1];
      };
      for (const offset of [-30, 0, 30]) {
        const y = Math.floor(canvas.height / 2) + offset;
        const wanted = darkBounds(expected, y); const observed = darkBounds(actual, y);
        for (let i = 0; i < 2; i++) edgeDisplacement = Math.max(edgeDisplacement, Math.abs(wanted[i] - observed[i]));
      }
      done({ size: [result.naturalWidth, result.naturalHeight], maximumError, interiorError,
        edgeDisplacement,
        cornerAlpha: actual[3], centerAlpha: actual[(Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4 + 3] });
    } catch (error) { done({ error: String(error) }); }
  }, dataUrl(original, extension), dataUrl(output, extension), padded) as Promise<{
    size: number[]; maximumError: number; interiorError: number; edgeDisplacement: number; cornerAlpha: number; centerAlpha: number; error?: string;
  }>;
}
function icons(bytes: Buffer): Map<string, Buffer> {
  expect(bytes.subarray(0, 4).toString()).toBe("icns");
  expect(bytes.readUInt32BE(4)).toBe(bytes.length);
  const result = new Map<string, Buffer>();
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThanOrEqual(8);
    expect(offset + length).toBeLessThanOrEqual(bytes.length);
    result.set(bytes.subarray(offset, offset + 4).toString(), bytes.subarray(offset + 8, offset + length));
    offset += length;
  }
  return result;
}

const nativeDescribe = process.platform === "linux" || process.platform === "win32" ? describe : describe.skip;
nativeDescribe("native image cropping", () => {
  before(async () => { await browser.setWindowSize(1400, 1000); });
  afterEach(async () => {
    if (await $(dialog).isDisplayed()) {
      await browser.keys("Escape");
      await $(dialog).waitForDisplayed({ reverse: true });
    }
  });
  for (const extension of ["png", "jpg", "gif", "webp", "bmp", "svg", "avif", "icns"]) {
    it(`saves a real ${extension} copy, preserves the original and displays the output`, async () => {
      const name = `quadrants.${extension}`;
      const source = path.join(scratch, name);
      const original = fs.readFileSync(path.join(fixtures, name)); fs.writeFileSync(source, original);
      await open(source);
      await expect(slider("Right")).toHaveAttribute("aria-valuenow", extension === "icns" ? "256" : "512");
      if (extension === "icns") {
        await crop(16, 16, 240, 240);
        await expect($(".crop-note")).toHaveText(expect.stringContaining("transparent padding"));
      } else await crop();
      await screenshot(`${extension}-selected-region`);
      await button("Save copy").click();
      await $(dialog).waitForDisplayed({ reverse: true });
      const target = path.join(scratch, `quadrants - Cropped.${extension}`);
      await browser.waitUntil(() => fs.existsSync(target), { timeoutMsg: "native crop output was not published" });
      expect(fs.readFileSync(source).equals(original)).toBe(true);
      const output = fs.readFileSync(target);
      if (extension === "icns") {
        const inputIcons = icons(original); const outputIcons = icons(output);
        expect([...outputIcons.keys()].sort()).toEqual([...inputIcons.keys()].sort());
        const observed = await compare(inputIcons.get("ic08")!, outputIcons.get("ic08")!, "png", true);
        expect(observed).toEqual({ size: [256, 256], maximumError: 0, interiorError: 0, edgeDisplacement: 0, cornerAlpha: 0, centerAlpha: 0 });
        const small = outputIcons.get("ic07")!;
        expect(small.subarray(1, 4).toString()).toBe("PNG");
        expect([small.readUInt32BE(16), small.readUInt32BE(20)]).toEqual([128, 128]);
      } else {
        const observed = await compare(original, output, extension);
        expect(observed.error).toBeUndefined();
        expect(observed.size).toEqual([448, 336]);
        if (extension === "jpg") {
          expect(observed.interiorError).toBeLessThanOrEqual(25);
          expect(observed.edgeDisplacement).toBeLessThanOrEqual(1);
        }
        else expect(observed.maximumError).toBe(0);
        if (["png", "webp", "bmp", "avif"].includes(extension)) expect(observed.centerAlpha).toBe(0);
      }
      const row = $(entryPathSelector(target)); await row.waitForDisplayed(); await row.click();
      await browser.waitUntil(async () => browser.executeAsync(async (expected: number[], done: (ready: boolean) => void) => {
        const image = document.querySelector<HTMLImageElement>(".preview-image");
        if (!image?.complete || !image.naturalWidth) { done(false); return; }
        // SVG naturalWidth is CSS-layout-dependent in WebKit. Inspect the
        // actual displayed URL through an unstyled image instead.
        const intrinsic = new Image(); intrinsic.src = image.src;
        try { await intrinsic.decode(); done(intrinsic.naturalWidth === expected[0] && intrinsic.naturalHeight === expected[1]); }
        catch { done(false); }
      }, extension === "icns" ? [256, 256] : [448, 336]), { timeoutMsg: "native output dimensions did not reach the preview" });
      await screenshot(`${extension}-saved-copy`);
    });
  }
  for (const mode of ["Details", "List", "Tiles"]) {
    it(`requires confirmation for a real original replacement in ${mode}`, async () => {
      await command(`${mode} View`);
      const source = path.join(scratch, `replace-${mode}.png`);
      const original = fs.readFileSync(path.join(fixtures, "quadrants.png")); fs.writeFileSync(source, original);
      await open(source); await crop();
      await button("Replace original…").click(); await screenshot(`${mode.toLowerCase()}-confirm-replacement`);
      await button("Keep editing").click(); expect(fs.readFileSync(source).equals(original)).toBe(true);
      await button("Cancel").click(); await $(dialog).waitForDisplayed({ reverse: true });
      expect(fs.readFileSync(source).equals(original)).toBe(true);
      await button("Crop image…").click(); await slider("Right").waitForDisplayed(); await crop();
      await button("Replace original…").click(); await button("Confirm replacement").click();
      await $(dialog).waitForDisplayed({ reverse: true });
      const observed = await compare(original, fs.readFileSync(source), "png");
      expect(observed.size).toEqual([448, 336]); expect(observed.maximumError).toBe(0);
      await browser.waitUntil(async () => browser.execute(() => document.querySelector<HTMLImageElement>(".preview-image")?.naturalWidth === 448));
      await screenshot(`${mode.toLowerCase()}-replaced-original`);
    });
  }
  it("refuses a changed real source without publishing a stale copy", async () => {
    const source = path.join(scratch, "changed.png");
    const original = fs.readFileSync(path.join(fixtures, "quadrants.png")); fs.writeFileSync(source, original);
    await open(source); await crop();
    const changed = Buffer.concat([original, Buffer.from("another writer")]); fs.writeFileSync(source, changed);
    await button("Save copy").click();
    await browser.waitUntil(async () => (await domText(`${dialog} [role="alert"]`)).includes("changed"));
    expect(fs.readFileSync(source).equals(changed)).toBe(true);
    expect(fs.existsSync(path.join(scratch, "changed - Cropped.png"))).toBe(false);
    await screenshot("changed-source-refused");
    await button("Cancel").click(); await $(dialog).waitForDisplayed({ reverse: true });
  });
});
