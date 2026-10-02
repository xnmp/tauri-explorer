import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { domText, entryPathSelector, navigateTo } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";
import { formatSize } from "../../src/lib/domain/file";

const fixtures = fileURLToPath(new URL("../fixtures/image-crop/", import.meta.url));
const codecFixtures = fileURLToPath(new URL("../../src-tauri/test_support/fixtures/", import.meta.url));
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
async function compare(original: Buffer, output: Buffer, extension: string, padded = false, rectangle: number[] = [32, 24, 448, 336], referenceExtension = extension) {
  return browser.executeAsync(async (original: string, saved: string, padded: boolean, measureEdges: boolean, rectangle: number[], done: (result: unknown) => void) => {
    try {
      const load = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); return image; };
      const [source, result] = await Promise.all([load(original), load(saved)]);
      const canvas = document.createElement("canvas");
      canvas.width = result.naturalWidth; canvas.height = result.naturalHeight;
      const context = canvas.getContext("2d")!;
      if (padded) context.drawImage(source, 16, 16, 224, 224, 16, 16, 224, 224);
      else context.drawImage(source, rectangle[0], rectangle[1], rectangle[2], rectangle[3], 0, 0, rectangle[2], rectangle[3]);
      const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(result, 0, 0);
      const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let maximumError = 0;
      // JPEG edges may change when the selected area is encoded as new blocks;
      // compare interior samples there, every pixel in the lossless formats.
      for (let i = 0; i < actual.length; i++) maximumError = Math.max(maximumError, Math.abs(actual[i] - expected[i]));
      const insetX = Math.min(40, Math.floor(canvas.width / 4));
      const insetY = Math.min(40, Math.floor(canvas.height / 4));
      const samples = [[insetX, insetY], [canvas.width - 1 - insetX, insetY], [insetX, canvas.height - 1 - insetY], [canvas.width - 1 - insetX, canvas.height - 1 - insetY]];
      let interiorError = 0;
      for (const [x, y] of samples) for (let c = 0; c < 3; c++) {
        const index = (y * canvas.width + x) * 4 + c;
        interiorError = Math.max(interiorError, Math.abs(actual[index] - expected[index]));
      }
      let edgeDisplacement = 0;
      if (measureEdges) {
        // Track the four actual quadrant boundaries, away from the center.
        // A missing transition is a failed oracle, never a matching sentinel.
        const transition = (data: Uint8ClampedArray, horizontal: boolean, fixed: number, positive: number, negative: number) => {
          const length = horizontal ? canvas.width : canvas.height;
          for (let p = 0; p < length; p++) {
            const i = (horizontal ? fixed * canvas.width + p : p * canvas.width + fixed) * 4;
            if (data[i + positive] > data[i + negative]) {
              if (p === 0 || p === length - 1) throw new Error("JPEG fixture has no interior color transition");
              return p;
            }
          }
          throw new Error("JPEG fixture has no color transition");
        };
        for (const [horizontal, fixed, positive, negative] of [
          [true, Math.floor(canvas.height / 4), 1, 0],
          [true, Math.floor(canvas.height * 3 / 4), 0, 2],
          [false, Math.floor(canvas.width / 4), 2, 0],
          [false, Math.floor(canvas.width * 3 / 4), 0, 1],
        ] as const) {
          edgeDisplacement = Math.max(edgeDisplacement, Math.abs(transition(actual, horizontal, fixed, positive, negative) - transition(expected, horizontal, fixed, positive, negative)));
        }
      }
      done({ size: [result.naturalWidth, result.naturalHeight], maximumError, interiorError,
        edgeDisplacement,
        cornerAlpha: actual[3], centerAlpha: actual[(Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4 + 3] });
    } catch (error) { done({ error: String(error) }); }
  }, dataUrl(original, referenceExtension), dataUrl(output, extension), padded, extension === "jpg", rectangle) as Promise<{
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
  it("maps an EXIF-oriented original through editor zoom and scrolling without rotating twice", async () => {
    const source = path.join(scratch, "oriented.png");
    const original = fs.readFileSync(path.join(fixtures, "oriented.png")); fs.writeFileSync(source, original);
    await open(source);
    await expect(slider("Right")).toHaveAttribute("aria-valuenow", "384");
    await expect(slider("Bottom")).toHaveAttribute("aria-valuenow", "512");
    await crop(24, 32, 360, 480);
    await screenshot("oriented-selected-region");
    await $("button[aria-label='Zoom in crop']").click();
    await $("button[aria-label='Zoom in crop']").click();
    await browser.execute(() => document.querySelector(".crop-scroller")?.scrollTo(90, 120));
    await expect(slider("Right")).toHaveAttribute("aria-valuenow", "360");
    await button("Save copy").click(); await $(dialog).waitForDisplayed({ reverse: true });
    const target = path.join(scratch, "oriented - Cropped.png");
    expect(fs.readFileSync(source).equals(original)).toBe(true);
    const reference = fs.readFileSync(path.join(fixtures, "oriented-reference.png"));
    const observed = await compare(reference, fs.readFileSync(target), "png", false, [24, 32, 336, 448]);
    expect(observed.error).toBeUndefined(); expect(observed.size).toEqual([336, 448]); expect(observed.maximumError).toBe(0);
    await $(entryPathSelector(target)).click();
    await browser.waitUntil(async () => browser.execute(() => {
      const image = document.querySelector<HTMLImageElement>(".preview-image");
      return image?.naturalWidth === 336 && image.naturalHeight === 448;
    }));
    await screenshot("oriented-saved-copy");
  });
  it("maps WebP EXIF coordinates to the full-resolution saved region", async () => {
    const source = path.join(scratch, "oriented.webp");
    const original = fs.readFileSync(path.join(fixtures, "oriented.webp")); fs.writeFileSync(source, original);
    const referenceUrl = await browser.executeAsync(async (url: string, done: (url: string) => void) => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.naturalHeight; canvas.height = image.naturalWidth;
      const context = canvas.getContext("2d")!;
      context.translate(canvas.width, 0); context.rotate(Math.PI / 2); context.drawImage(image, 0, 0);
      done(canvas.toDataURL("image/png"));
    }, dataUrl(fs.readFileSync(path.join(fixtures, "quadrants.webp")), "webp"));
    const reference = Buffer.from(referenceUrl.split(",")[1], "base64");
    await open(source);
    await expect(slider("Right")).toHaveAttribute("aria-valuenow", "384");
    await expect(slider("Bottom")).toHaveAttribute("aria-valuenow", "512");
    await crop(24, 32, 360, 480); await screenshot("webp-oriented-selected-region");
    await button("Save copy").click(); await $(dialog).waitForDisplayed({ reverse: true });
    const target = path.join(scratch, "oriented - Cropped.webp");
    expect(fs.readFileSync(source).equals(original)).toBe(true);
    const observed = await compare(reference, fs.readFileSync(target), "webp", false, [24, 32, 336, 448], "png");
    expect(observed.error).toBeUndefined(); expect(observed.size).toEqual([336, 448]); expect(observed.maximumError).toBe(0);
    await $(entryPathSelector(target)).click();
    await browser.waitUntil(async () => browser.execute(() => document.querySelector<HTMLImageElement>(".preview-image")?.naturalWidth === 336));
    await screenshot("webp-oriented-saved-copy");
  });
  for (const [name, width, height] of [["oriented", 8, 12], ["aspect", 12, 16]] as const) {
    it(`uses normalized AVIF ${name} pixels through capture and actual save`, async () => {
      const source = path.join(scratch, `${name}.avif`);
      const original = fs.readFileSync(path.join(codecFixtures, `image-crop-${name}.avif`)); fs.writeFileSync(source, original);
      await open(source);
      await expect(slider("Right")).toHaveAttribute("aria-valuenow", String(width));
      await expect(slider("Bottom")).toHaveAttribute("aria-valuenow", String(height));
      await crop(1, 2, width - 1, height - 2);
      await $("button[aria-label='Zoom in crop']").click();
      await $("button[aria-label='Zoom in crop']").click();
      await $("button[aria-label='Zoom in crop']").click();
      await screenshot(`avif-${name}-selected-region`);
      await button("Save copy").click(); await $(dialog).waitForDisplayed({ reverse: true });
      const target = path.join(scratch, `${name} - Cropped.avif`);
      expect(fs.readFileSync(source).equals(original)).toBe(true);
      await $(entryPathSelector(target)).click();
      await browser.waitUntil(async () => browser.execute((size: number[]) => {
        const image = document.querySelector<HTMLImageElement>(".preview-image");
        return image?.naturalWidth === size[0] && image.naturalHeight === size[1];
      }, [width - 2, height - 4]));
      if (name === "oriented") {
        const reference = fs.readFileSync(path.join(codecFixtures, "image-crop-oriented-reference.png"));
        const observed = await compare(reference, fs.readFileSync(target), "avif", false, [1, 2, 6, 8], "png");
        expect(observed.error).toBeUndefined(); expect(observed.size).toEqual([6, 8]); expect(observed.maximumError).toBe(0);
      }
      await screenshot(`avif-${name}-saved-copy`);
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
      const expectedSize = formatSize(fs.statSync(source).size);
      await browser.waitUntil(async () => (await domText(".preview-info .info-row:first-child .info-value")) === expectedSize,
        { timeout: 15_000, timeoutMsg: "Replacement preview metadata did not settle to the actual file size" });
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
