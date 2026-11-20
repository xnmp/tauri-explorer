/**
 * What a translucent window paints, measured from pixels (#1789). The page is
 * screenshotted over a black and a white backdrop (the html background, which
 * stands in for the native material). Over black a point shows colour x alpha,
 * over white that plus (1 - alpha) x 255, which gives the share of the
 * material the point hides (alpha) and its colour. Computed styles cannot
 * prove this: layers stacked on each other compound, and only the raster
 * shows the sum.
 */
import type { Page } from "@playwright/test";
import { decodePng, type PngPixels } from "./png-pixels";

export type Rgb = [number, number, number];

export interface Painted {
  /** Share of the material the point hides, 0 to 1. */
  alpha: number;
  /** The colour it paints (meaningless where alpha is near 0). */
  rgb: Rgb;
}

export interface MaterialShot {
  width: number;
  height: number;
  at: (x: number, y: number) => Painted;
}

async function shotOver(page: Page, backdrop: string): Promise<Buffer> {
  await page.evaluate((colour) => {
    let style = document.getElementById("material-backdrop-probe");
    if (!style) {
      style = document.createElement("style");
      style.id = "material-backdrop-probe";
      document.head.appendChild(style);
    }
    style.textContent = `html { background: ${colour} !important; }`;
  }, backdrop);
  // One pixel per CSS px, whatever the device scale (the WebKit project runs at 2x).
  return page.screenshot({ animations: "disabled", scale: "css" });
}

/**
 * Screenshots the page over black and white; `at` solves any point (CSS px).
 * The solve assumes the page is the same in both shots, so it shoots black,
 * white, black and retries until the two black shots agree: a row still
 * loading or a pane still moving in would read as a hole.
 */
export async function materialShot(page: Page): Promise<MaterialShot> {
  let pair: { black: PngPixels; white: PngPixels } | undefined;
  for (let attempt = 0; attempt < 6 && !pair; attempt++) {
    const before = await shotOver(page, "#000");
    const white = await shotOver(page, "#fff");
    const after = await shotOver(page, "#000");
    if (before.equals(after)) pair = { black: decodePng(before), white: decodePng(white) };
    else await page.waitForTimeout(250);
  }
  await page.evaluate(() => document.getElementById("material-backdrop-probe")?.remove());
  if (!pair) throw new Error("materialShot: the page kept changing between screenshots");
  const { black, white } = pair;
  return {
    width: black.width,
    height: black.height,
    at(x, y) {
      const b = black.pixel(Math.round(x), Math.round(y));
      const w = white.pixel(Math.round(x), Math.round(y));
      const alpha = 1 - (w[0] - b[0] + w[1] - b[1] + w[2] - b[2]) / 3 / 255;
      return { alpha, rgb: b.map((c) => (alpha > 0.01 ? c / alpha : 0)) as Rgb };
    },
  };
}

/**
 * Hides text and icons, leaving only surfaces and borders. Glyph antialiasing
 * does not blend linearly (WebKit's differs over black and white), so a scan
 * across text reads false holes; a slit is a surface defect, not a glyph's.
 * The fill colour is hidden, not `color`, so currentColor borders stay.
 */
export async function hideContent(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "* { -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } svg, img, canvas, video { visibility: hidden !important; }",
  });
}

/** Largest channel difference between two colours. */
export const colourDistance = (a: Rgb, b: Rgb): number => Math.max(...a.map((c, i) => Math.abs(c - b[i])));

/** `prefers-reduced-transparency: reduce` for the page (Chromium, through CDP). */
export async function emulateReducedTransparency(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
}
