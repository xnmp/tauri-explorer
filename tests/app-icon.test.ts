/**
 * Application icon contracts (#1553, #1732): the canonical artwork's tau is
 * filled, the README records the artwork actually committed, the Windows ICO
 * no longer stretches the folder to the frame edge, and only the macOS ICNS is
 * an opaque Apple-grid squircle while the other platforms keep the standalone,
 * transparent-cornered folder.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// Literal paths so the unit-test selector's text scan finds these inputs.
const ICON_PNG = new URL("../src-tauri/icons/icon.png", import.meta.url);
const APERTURE_PNG = new URL("../src-tauri/icons/icon-aperture.png", import.meta.url);
const ICON_ICO = new URL("../src-tauri/icons/icon.ico", import.meta.url);
const ICON_ICNS = new URL("../src-tauri/icons/icon.icns", import.meta.url);
const ICON_128 = new URL("../src-tauri/icons/128x128.png", import.meta.url);
const GEN_ICONS = new URL("../src-tauri/icons/gen_icons.py", import.meta.url);
const README = new URL("../src-tauri/icons/README.md", import.meta.url);

interface Rgba {
  width: number;
  height: number;
  alpha: Uint8Array;
}

/** Minimal decoder for the 8-bit, non-interlaced RGB(A) PNGs Pillow writes. */
function decodePngAlpha(png: Buffer): Rgba {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = data.subarray(8, 13);
      expect({ depth, interlace }).toEqual({ depth: 8, interlace: 0 });
      expect([2, 6]).toContain(colorType);
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0;
      const b = y > 0 ? pixels[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[row + x] = (raw[src + x] + predictor) & 0xff;
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = channels === 4 ? pixels[i * 4 + 3] : 255;
  }
  return { width, height, alpha };
}

/** Transparent (alpha < 128) pixels that cannot be reached from the canvas border. */
function enclosedTransparentPixels({ width, height, alpha }: Rgba): number {
  const reached = new Uint8Array(width * height);
  const stack: number[] = [];
  const visit = (i: number) => {
    if (!reached[i] && alpha[i] < 128) {
      reached[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < width * (height - 1)) visit(i + width);
  }
  let enclosed = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] < 128 && !reached[i]) enclosed++;
  return enclosed;
}

function icoFrames(ico: Buffer): Map<number, Buffer> {
  expect(ico.readUInt16LE(2)).toBe(1);
  const frames = new Map<number, Buffer>();
  for (let k = 0; k < ico.readUInt16LE(4); k++) {
    const entry = 6 + 16 * k;
    const size = ico[entry] || 256;
    const length = ico.readUInt32LE(entry + 8);
    const start = ico.readUInt32LE(entry + 12);
    frames.set(size, ico.subarray(start, start + length));
  }
  return frames;
}

/** PNG-encoded ICNS elements by OSType (e.g. "ic10" = 512@2x, the 1024px frame). */
function icnsPngFrames(icns: Buffer): Map<string, Buffer> {
  expect(icns.toString("ascii", 0, 4)).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  const frames = new Map<string, Buffer>();
  let offset = 8;
  while (offset < icns.length) {
    const type = icns.toString("ascii", offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThanOrEqual(8);
    const data = icns.subarray(offset + 8, offset + length);
    if (data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") frames.set(type, data);
    offset += length;
  }
  return frames;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Bounding box (exclusive right/bottom) of pixels with alpha above `threshold`. */
function opaqueBounds({ width, alpha }: Rgba, threshold = 200): Box {
  const box = { left: width, top: Infinity, right: -1, bottom: -1 };
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] <= threshold) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    box.left = Math.min(box.left, x);
    box.right = Math.max(box.right, x + 1);
    box.top = Math.min(box.top, y);
    box.bottom = Math.max(box.bottom, y + 1);
  }
  return box;
}

/** Alpha at a point given as fractions of a box (0..1 across, 0..1 down). */
function alphaWithin(image: Rgba, box: Box, fx: number, fy: number): number {
  const x = Math.floor(box.left + fx * (box.right - box.left));
  const y = Math.floor(box.top + fy * (box.bottom - box.top));
  return image.alpha[y * image.width + x];
}

/**
 * The notch beside the folder tab: near the top edge, three quarters of the
 * way across the folder's opaque box. The standalone folder is see-through
 * there; the macOS squircle fills it with its deep-teal tile.
 */
const NOTCH = [0.75, 0.04] as const;

/** Standalone folder: transparent canvas corners and a see-through notch. */
function expectStandaloneFolder(image: Rgba) {
  const { width, height, alpha } = image;
  for (const [x, y] of [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]) {
    expect(alpha[y * width + x]).toBe(0);
  }
  const box = opaqueBounds(image);
  // No squircle-style margin: the folder spans most of the frame.
  expect((box.right - box.left) / width).toBeGreaterThan(0.8);
  expect(alphaWithin(image, box, 0.5, 0.5)).toBeGreaterThan(200);
  expect(alphaWithin(image, box, ...NOTCH)).toBeLessThan(16);
}

describe("application icon (#1553)", () => {
  it("fills the tau: the canonical icon has no enclosed see-through aperture", () => {
    // The input artwork still has the aperture, proving the check can see it.
    expect(enclosedTransparentPixels(decodePngAlpha(readFileSync(APERTURE_PNG)))).toBeGreaterThan(
      50_000,
    );
    expect(enclosedTransparentPixels(decodePngAlpha(readFileSync(ICON_PNG)))).toBe(0);
  });

  it("records the committed canonical icon's SHA-256 in the README", () => {
    const sha = createHash("sha256").update(readFileSync(ICON_PNG)).digest("hex");
    expect(readFileSync(README, "utf8")).toContain(sha);
  });

  it("keeps the Windows ICO enlargement within the frame", () => {
    const match = /^ICO_CONTENT_SCALE = ([\d.]+)$/m.exec(readFileSync(GEN_ICONS, "utf8"));
    expect(match).not.toBeNull();
    const scale = Number(match![1]);
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(scale).toBeLessThanOrEqual(1.05);

    // The generated 256px frame keeps a transparent margin around the folder
    // (1.11 stretched it to ~96% of the frame) and also has a filled tau.
    const frame = decodePngAlpha(icoFrames(readFileSync(ICON_ICO)).get(256)!);
    let minX = frame.width;
    let maxX = -1;
    for (let i = 0; i < frame.alpha.length; i++) {
      if (frame.alpha[i] > 200) {
        minX = Math.min(minX, i % frame.width);
        maxX = Math.max(maxX, i % frame.width);
      }
    }
    expect((maxX - minX + 1) / frame.width).toBeLessThanOrEqual(0.9);
    expect(enclosedTransparentPixels(frame)).toBe(0);
  });
});

describe("macOS squircle ICNS (#1732)", () => {
  // Apple's macOS icon grid: a 1024 canvas with an 824 tile centred on it.
  // The tile is the superellipse |x|^5 + |y|^5 = 412^5 around the centre.
  const CANVAS = 1024;
  const TILE = 824;
  const EXPONENT = 5;
  const frame = () => {
    const ic10 = icnsPngFrames(readFileSync(ICON_ICNS)).get("ic10");
    expect(ic10).toBeDefined();
    return decodePngAlpha(ic10!);
  };

  it("draws the 1024px ic10 frame as an opaque superellipse tile on Apple's grid", () => {
    const image = frame();
    expect({ width: image.width, height: image.height }).toEqual({
      width: CANVAS,
      height: CANVAS,
    });

    const half = TILE / 2;
    let outsideVisible = 0;
    let insideTranslucent = 0;
    for (let y = 0; y < CANVAS; y++) {
      for (let x = 0; x < CANVAS; x++) {
        const dx = Math.abs(x + 0.5 - CANVAS / 2);
        const dy = Math.abs(y + 0.5 - CANVAS / 2);
        const radius = (dx ** EXPONENT + dy ** EXPONENT) ** (1 / EXPONENT);
        const a = image.alpha[y * CANVAS + x];
        // Allow the one-pixel antialiased edge band either side.
        if (radius > half + 1.5 && a !== 0) outsideVisible++;
        if (radius < half - 1.5 && a !== 255) insideTranslucent++;
      }
    }
    expect(outsideVisible).toBe(0);
    expect(insideTranslucent).toBe(0);

    const box = opaqueBounds(image, 128);
    for (const extent of [box.right - box.left, box.bottom - box.top]) {
      expect(Math.abs(extent - TILE)).toBeLessThanOrEqual(2);
    }
    expect(Math.abs((box.left + box.right) / 2 - CANVAS / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((box.top + box.bottom) / 2 - CANVAS / 2)).toBeLessThanOrEqual(1);

    // The notch beside the tab is filled, unlike the standalone folder's.
    expect(alphaWithin(image, box, ...NOTCH)).toBe(255);
  });

  it("keeps the canonical folder art standalone everywhere else", () => {
    expectStandaloneFolder(decodePngAlpha(readFileSync(ICON_128)));
    expectStandaloneFolder(decodePngAlpha(icoFrames(readFileSync(ICON_ICO)).get(256)!));
    expectStandaloneFolder(decodePngAlpha(readFileSync(ICON_PNG)));
  });
});
