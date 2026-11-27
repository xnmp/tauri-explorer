/**
 * Themed scrollbars (#1920). The thumb is a thin neutral line at rest, an
 * accent-tinted 4px bar while the pointer is over its scroller, and a 6px
 * accent bar under the pointer; themes restyle it through --scrollbar-*
 * tokens. Asserted on painted pixels, since scrollbar pseudo-elements have no
 * computed style a page can read.
 *
 * Headless Chromium hides scrollbars by default, so this spec launches its own
 * browser with classic ones. The pane-hover state also guards the Chromium
 * restyle hook in +page.svelte: without it the scrollbar keeps its idle look
 * until some unrelated restyle.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { seedSettings, waitForEntries } from "./helpers";
import { captureEvidence } from "./evidence-shots";

test.use({
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  },
});

const SHOTS = "screenshots/feat/thematic-scrollbars";
// 54 entries: tall enough to scroll, short enough for a long thumb.
const DIR = "/folder-peek-tiles-rows";

type Rgb = [number, number, number];

interface Gutter {
  /** Right edge of the scroller's border box, in CSS px. */
  right: number;
  /** Vertical centre of the thumb (scrolled to the top). */
  thumbY: number;
  /** A point on the empty track below the thumb. */
  trackY: number;
  centreX: number;
  centreY: number;
}

async function openThemed(page: Page, theme: string): Promise<Gutter> {
  await seedSettings(page, { theme, zoomLevel: 100 }, { replace: true });
  await page.setViewportSize({ width: 1300, height: 560 });
  await page.goto(`/?path=${DIR}&viewMode=details`);
  await waitForEntries(page);
  const scroller = page.locator(".details-view .virtual-viewport").first();
  const g = await scroller.evaluate((el) => {
    el.scrollTop = 0;
    const r = el.getBoundingClientRect();
    const thumbLength = (el.clientHeight * el.clientHeight) / el.scrollHeight;
    return {
      scrolls: el.scrollHeight > el.clientHeight * 2,
      classic: r.width - el.clientWidth >= 8,
      right: Math.floor(r.right),
      thumbY: Math.round(r.top + thumbLength / 2),
      trackY: Math.round(r.top + el.clientHeight - 12),
      centreX: Math.round(r.left + r.width / 2),
      centreY: Math.round(r.top + 60),
    };
  });
  expect(g.scrolls, "fixture folder must scroll with room below the thumb").toBe(true);
  expect(g.classic, "spec needs a classic 8px scrollbar gutter").toBe(true);
  return g;
}

/** Read viewport pixels from a fresh screenshot (CSS px, DPR 1). */
async function pixels(page: Page, points: [number, number][]): Promise<Rgb[]> {
  await page.waitForTimeout(100); // let the hover restyle paint
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(async ({ png, points }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)) as Rgb);
  }, { png, points });
}

const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const chroma = ([r, g, b]: Rgb) => Math.max(r, g, b) - Math.min(r, g, b);

/** Centre column of the 2px idle thumb, and a column only the 6px thumb covers. */
const thumbSamples = (g: Gutter): [number, number][] => [
  [g.right - 4, g.thumbY],
  [g.right - 6, g.thumbY],
  [g.right - 4, g.trackY],
];

test.describe("themed scrollbars", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "classic scrollbars are forced through a Chromium launch flag");

  test("thumb is neutral at rest, takes the accent near the pointer, and grows on hover", async ({ page }) => {
    const g = await openThemed(page, "light"); // no signature: the default tokens
    const accent: Rgb = [0x00, 0x66, 0xcc];

    await page.mouse.move(5, 5);
    const [idle, idleOuter, track] = await pixels(page, thumbSamples(g));
    expect(distance(idle, track), "idle thumb is visible").toBeGreaterThan(25);
    expect(chroma(idle), "idle thumb is neutral grey").toBeLessThan(25);
    expect(distance(idleOuter, track), "idle thumb is a thin line").toBeLessThan(12);

    await page.mouse.move(g.centreX, g.centreY);
    const [pane] = await pixels(page, thumbSamples(g));
    expect(pane[2] - pane[0], "pointer over the pane tints the thumb with the accent").toBeGreaterThan(60);

    await page.mouse.move(g.right - 4, g.thumbY);
    const [hover, hoverOuter] = await pixels(page, thumbSamples(g));
    expect(distance(hover, accent), "thumb under the pointer is the accent").toBeLessThan(30);
    expect(distance(hoverOuter, accent), "thumb under the pointer is wider").toBeLessThan(40);

    await page.mouse.move(5, 5);
    const [left] = await pixels(page, thumbSamples(g));
    expect(distance(left, idle), "leaving the pane restores the idle thumb").toBeLessThan(12);
  });

  test("a theme's signature tokens restyle the thumb", async ({ page }) => {
    const g = await openThemed(page, "gruvbox");
    await page.mouse.move(g.right - 4, g.thumbY);
    const [hover] = await pixels(page, thumbSamples(g));
    // Gruvbox's yellow-to-burnt-orange ramp, not the default single accent.
    expect(hover[0] - hover[2], "gruvbox thumb is warm").toBeGreaterThan(120);
  });

  test("the hover restyle hook stays cheap", async ({ page }) => {
    // The hook must restyle only the hovered element. A custom-property hook
    // restyled the hovered element's whole subtree: ~500 elements per move
    // here, against ~17 for the shipped one and ~2.5 with no hook at all.
    const g = await openThemed(page, "light");
    const cdp = await page.context().newCDPSession(page);
    const events: { name: string; args?: { elementCount?: number } }[] = [];
    cdp.on("Tracing.dataCollected", (e) => events.push(...(e.value as typeof events)));
    await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
    const moves = 40;
    for (let i = 0; i < moves / 4; i++) {
      for (const [x, y] of [[g.centreX, g.centreY], [100, g.centreY], [g.centreX, g.centreY], [-1, -1]]) {
        await page.mouse.move(x, y);
        await page.waitForTimeout(20);
      }
    }
    const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    await complete;
    const restyled = events
      .filter((e) => e.name === "UpdateLayoutTree")
      .reduce((sum, e) => sum + (e.args?.elementCount ?? 0), 0);
    expect(restyled / moves, "elements restyled per pointer move").toBeLessThan(80);
    // The app's own hover UI lays out on about every second move here (20 of
    // 40, with or without the hook). A hook property that forces layout
    // (shape-margin did) adds one on every move: 40 of 40.
    const layouts = events.filter((e) => e.name === "Layout").length;
    expect(layouts, "layouts during pure pointer moves").toBeLessThan(moves * 0.75);
  });

  test("evidence: themed scrollbar states", async ({ page }) => {
    test.skip(!captureEvidence, "evidence capture only");
    const themes = ["light", "catppuccin", "gruvbox", "hacker", "nord", "horizon", "tahoe", "solarized-light"];
    const cells: { theme: string; shots: string[] }[] = [];
    for (const theme of themes) {
      const g = await openThemed(page, theme);
      const clip = { x: g.right - 60, y: g.thumbY - 70, width: 60, height: 180 };
      const shots: string[] = [];
      for (const [x, y] of [[5, 5], [g.centreX, g.centreY], [g.right - 4, g.thumbY]]) {
        await page.mouse.move(x, y);
        await page.waitForTimeout(100);
        shots.push((await page.screenshot({ clip })).toString("base64"));
      }
      cells.push({ theme, shots });
    }
    const states = ["idle", "pane hover", "thumb hover"];
    await page.setViewportSize({ width: 1300, height: 500 });
    await page.setContent(`<body style="margin:12px;background:#777;font:12px system-ui;color:#fff;display:flex;flex-wrap:wrap;gap:16px">
      ${cells.map((c) => `<figure style="margin:0"><div style="display:flex;gap:3px">${c.shots.map((s, i) =>
        `<div style="display:flex;flex-direction:column;align-items:center"><img style="width:60px" src="data:image/png;base64,${s}"><small>${states[i]}</small></div>`).join("")}</div>
        <figcaption style="font-weight:600;margin-top:4px">${c.theme}</figcaption></figure>`).join("")}</body>`);
    await page.screenshot({ path: `${SHOTS}/scrollbar-theme-signatures.png`, fullPage: true });

    const g = await openThemed(page, "catppuccin");
    await page.mouse.move(g.centreX, g.centreY);
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${SHOTS}/scrollbar-idle-pane-hover.png`, clip: { x: g.right - 420, y: 0, width: 420, height: 560 } });
  });
});
