/**
 * Minimal PNG reader for pixel assertions on Playwright screenshots
 * (8-bit RGB/RGBA, non-interlaced, which is what the browsers emit).
 * Used where DOM geometry cannot prove what was rasterised, e.g. a
 * compositor-scaled layer under fractional zoom (#1051).
 */
import { inflateSync } from "node:zlib";

export interface PngPixels {
  width: number;
  height: number;
  /** [r, g, b] at integer coordinates. */
  pixel: (x: number, y: number) => [number, number, number];
}

export function decodePng(png: Buffer): PngPixels {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (pos + 12 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (data[8] !== 8 || channels === 0 || data[12] !== 0) throw new Error("unsupported PNG layout");
    } else if (type === "IDAT") {
      idat.push(data);
    }
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      let value: number;
      switch (filter) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[dst + x] = value & 255;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const i = (y * width + x) * channels;
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}

export function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
