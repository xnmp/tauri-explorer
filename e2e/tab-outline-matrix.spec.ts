/**
 * The active tab's outline, shadow and strip shade across the visual matrix
 * (#1734, #1785, #1856, #1858): layout (Floating Islands, Default; Compact on
 * Linux/Windows only) x macOS material (on,
 * off) x theme (light, dark), at rest with 1, 3 and 12 tabs, on hover, and
 * on frozen frames of a tab opening and closing, at 100% zoom on a 1x
 * display and 125% on a 2x one. Every check is a pixel comparison against
 * the same frame with one layer changed, so it holds for any theme or
 * wallpaper:
 *
 * - outline: outside the tab, the one outline reads exactly as a CSS border
 *   round the top of the tab's surface (edge to edge, with the layout's top
 *   corners: rounded in Floating Islands, square in Default): no doubling,
 *   gap, colour or alpha change, fade or step at a handover;
 * - islands (Floating Islands): every island's top edge and corners read
 *   exactly as without the tab's layers (the tab never opens or squares an
 *   island);
 * - foot: the tab and its surface are one across the strip base;
 * - shade: the strip shade never paints below the strip's base, and the
 *   pockets of shade below it only outside the surface's rounded top corners
 *   (Default's square corners have none);
 * - shadow (Floating Islands): a light shadow on the tab's left and top, a
 *   heavier one on its right, none below the base, and only ever round one
 *   tab; Default is flat and casts none;
 * - opacity: without the material no pixel depends on the window backdrop
 *   (no stray translucency); with it the strip shows the backdrop.
 */
import { test, expect, type Page } from "./fixtures";
import { pressShortcut, seedSettings, waitForEntries } from "./helpers";
import { steppedFrames } from "./tab-frames";

const SIMULATED_MATERIAL = `
  html {
    background:
      linear-gradient(rgba(128, 128, 128, 0.55), rgba(128, 128, 128, 0.55)),
      radial-gradient(70% 90% at 15% 20%, #e8875a 0%, transparent 60%),
      linear-gradient(135deg, #5b3c88, #1f6f6b) !important;
    background-attachment: fixed !important;
  }`;
const OTHER_BACKDROP = `html { background: linear-gradient(90deg, #ff0040, #00ff90) !important; background-attachment: fixed !important; }`;
/** Every island: each draws its own outline, radius and shadow. */
const ISLANDS = '[data-region="sidebar"], [data-region="panes"]:not([data-split]), [data-region="panes"][data-split] [data-region="pane"], [data-region="preview"], [data-region="miller-island"]';
/** The islands hidden: only the window body (the tab's surface) and the strip paint. */
const NO_ISLANDS = `${ISLANDS}, [data-region="status-bar"] { visibility: hidden !important; }`;
/**
 * Default: the sidebar, panes and status bar are the surface itself (#1856),
 * so they stay; their contents (and the sidebar's divider) are hidden.
 */
const SURFACE_ONLY = `[data-region="toolbar"] > *, [data-region="sidebar-body"] > *, [data-region="column-header"], [data-region="file-list"] > * { visibility: hidden !important; } [data-region="sidebar-body"] { box-shadow: none !important; }`;
/** The tab's layers hidden: the islands drawn alone. */
const NO_TAB_LAYERS = '[data-region="tab-edge"], [data-region="tab-key-shadow"] { visibility: hidden !important; }';
const PATHS = ["/home/user", "/home/user/Downloads", "/home/user/Documents"];

type Layout = "floating-islands" | "default" | "compact";
/** macOS with the material, macOS without it, and Linux/Windows (never any). */
type Platform = "mac-material" | "mac-opaque" | "opaque";
interface Cell { layout: Layout; platform: Platform; theme: "light" | "dark"; material: boolean }

const CELLS: Cell[] = [
  ...(["floating-islands", "default"] as const).flatMap((layout) =>
    (["mac-material", "mac-opaque", "opaque"] as const).flatMap((platform) =>
      (["light", "dark"] as const).map((theme) => ({ layout, platform, theme, material: platform === "mac-material" })))),
  // Compact is Default's surfaces in tighter chrome (#1858): its own sizes,
  // the platform paths are Default's.
  ...(["light", "dark"] as const).map((theme): Cell => ({ layout: "compact", platform: "opaque", theme, material: false })),
];
const label = ({ layout, platform, theme }: Cell) => `${layout === "floating-islands" ? "islands" : layout}, ${platform}, ${theme}`;

async function openCell(page: Page, cell: Cell, { count = 3, active = Math.min(count - 1, 1), zoom = 100 } = {}): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 600 });
  if (cell.platform !== "opaque") {
    await page.addInitScript(() => Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel", configurable: true }));
  }
  await seedSettings(page, {
    layoutTheme: cell.layout,
    theme: cell.theme,
    showWindowControls: true,
    // As on the real Mac capture: the integrated row holds the lone tab, since
    // the custom controls never render on macOS (#1756).
    integratedTitleBar: cell.platform !== "opaque",
    tabTitleGitRoot: false,
    zoomLevel: zoom,
    translucency: cell.material,
  });
  await page.addInitScript(({ paths, count, active }) => {
    localStorage.setItem("explorer-tabs", JSON.stringify({
      version: 3,
      tabs: Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, kind: "explorer", activePaneId: `m-pane-${i}`, layout: { type: "leaf", id: `m-pane-${i}`, path: paths[i % paths.length] } })),
      activeTabId: `m-${active}`,
    }));
  }, { paths: PATHS, count, active });
  await page.goto("/");
  await waitForEntries(page);
  if (cell.material) {
    await expect(page.locator("html")).toHaveAttribute("data-material", "vibrancy");
    await page.addStyleTag({ content: SIMULATED_MATERIAL });
  } else {
    await expect(page.locator("html")).not.toHaveAttribute("data-material");
  }
  // The lazily loaded marks have drawn the outline.
  await expect(page.locator('[data-region="tab-edge"] .tab-edge-stroke')).toHaveAttribute("d", /\S/);
  await page.mouse.move(5, 590);
  await settle(page);
}

/** Two rendered frames: the seam marks follow layout within one. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 30)))));
}

/** A viewport device-pixel screenshot, base64. */
async function shot(page: Page): Promise<string> {
  // Not `animations: "disabled"`: that finishes the frozen frame animations.
  return (await page.screenshot()).toString("base64");
}

/** Screenshot with a temporary style applied. */
async function shotWith(page: Page, css: string): Promise<string> {
  const tag = await page.addStyleTag({ content: css });
  await settle(page);
  const image = await shot(page);
  await tag.evaluate((el) => el.remove());
  await settle(page);
  return image;
}

interface Geometry {
  dpr: number;
  zoom: number;
  chromium: boolean;
  titlebar: { top: number; bottom: number; width: number };
  /** The strip's base: the active tab's bottom (Default keeps a row of the bar below it for the outline). */
  base: number;
  tab: { left: number; right: number; top: number; bottom: number } | null;
  hole: [number, number] | null;
  islands: { left: number; right: number; top: number; radius: number }[];
  /** The surface's top-corner radius (device-independent CSS px, zoomed). */
  surfaceRadius: number;
  /** The outline's colour, as the stylesheet gives it. */
  outlineColor: string;
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate((ISLANDS) => {
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const bar = document.querySelector('[data-region="titlebar"]')!.getBoundingClientRect();
    const tab = document.querySelector('.tab-viewport [data-region="tab"][aria-selected="true"]')?.getBoundingClientRect();
    const hole = document.querySelector('[data-region="titlebar"]')!.getAttribute("data-tab-hole");
    return {
      dpr: devicePixelRatio,
      zoom,
      chromium: /Chrome\//.test(navigator.userAgent),
      titlebar: { top: bar.top, bottom: bar.bottom, width: bar.width },
      base: tab ? tab.bottom : bar.bottom,
      tab: tab ? { left: tab.left, right: tab.right, top: tab.top, bottom: tab.bottom } : null,
      hole: hole ? (hole.split(" ").map((v) => Number(v) * zoom) as [number, number]) : null,
      islands: [...document.querySelectorAll<HTMLElement>(ISLANDS)]
        .filter((el) => !el.closest(".retained") && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility === "visible")
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, radius: (parseFloat(getComputedStyle(el).getPropertyValue("--layout-radius")) || 14) * zoom };
        }),
      // The radius the marks draw (0 in Default), not --layout-radius.
      surfaceRadius: (parseFloat(getComputedStyle(document.querySelector('[data-region="titlebar"]')!).getPropertyValue("--islands-surface-radius")) || 0) * zoom,
      outlineColor: getComputedStyle(document.querySelector('[data-region="tab-edge"] .surface-edge-stroke')!).stroke,
    };
  }, ISLANDS);
}

interface Region { x0: number; x1: number; y0: number; y1: number; skip?: { x0: number; x1: number; y0: number; y1: number }[] }

/**
 * Largest per-channel difference between two screenshots over device-pixel
 * regions, and how many pixels differ by more than `threshold`.
 */
async function maxDifference(page: Page, a: string, b: string, regions: Region[], threshold = 255): Promise<{ max: number; at: string; over: number }> {
  return page.evaluate(async ({ a, b, regions, threshold }) => {
    const load = async (data: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height);
    };
    const [A, B] = [await load(a), await load(b)];
    let max = 0;
    let at = "";
    let over = 0;
    for (const r of regions) {
      for (let y = Math.max(0, r.y0); y < Math.min(A.height, r.y1); y++) {
        for (let x = Math.max(0, r.x0); x < Math.min(A.width, r.x1); x++) {
          if (r.skip?.some((s) => x >= s.x0 && x < s.x1 && y >= s.y0 && y < s.y1)) continue;
          const i = (y * A.width + x) * 4;
          const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
          if (d > threshold) over++;
          if (d > max) { max = d; at = `(${x},${y}) ${A.data[i]},${A.data[i + 1]},${A.data[i + 2]} vs ${B.data[i]},${B.data[i + 1]},${B.data[i + 2]}`; }
        }
      }
    }
    return { max, at, over };
  }, { a, b, regions, threshold });
}

/** Device-pixel edge as layout snaps it (Chromium: whole zoomed CSS pixels). */
const snap = (g: Geometry, visual: number) => (g.chromium ? Math.round(visual) * g.dpr : Math.round(visual * g.dpr));

/**
 * Outline: outside the tab's hole, the one outline reads exactly as a CSS
 * border round the top of the tab's surface: 1px, the outline's colour, edge
 * to edge below the strip base with the surface's top corners (#1785; square
 * in Default, #1856). A doubled stroke, a gap, a colour or alpha change, a fade
 * or a step at a handover would all differ.
 */
async function expectOutline(page: Page, what: string): Promise<void> {
  const g = await geometry(page);
  const actual = await shot(page);
  const reference = await shotWithSurfaceBorder(page);
  const base = snap(g, g.base);
  const width = Math.round(g.titlebar.width * g.dpr);
  const radius = Math.ceil(g.surfaceRadius * g.dpr);
  const corner = radius + 4 * g.dpr;
  const foot = 3 * g.dpr;
  const hole = g.hole ? [{ x0: Math.floor(g.hole[0] * g.dpr) - foot, x1: Math.ceil(g.hole[1] * g.dpr) + foot, y0: 0, y1: base + corner }] : [];
  // The straight top edge, between the corners: exactly the border.
  const straight = await maxDifference(page, actual, reference, [{ x0: corner, x1: width - corner, y0: base - g.dpr, y1: base + 4 * g.dpr, skip: hole }]);
  expect(straight.max, `${what}: the outline's top edge vs a CSS border round the surface, worst ${straight.at}`).toBeLessThanOrEqual(4);
  // The corners, down past where each arc meets the window's side: a CSS
  // border ring and an SVG stroke anti-alias the same arc differently (by up
  // to 9 on a few pixels at 1x; up to 13, on 41 pixels by more than 6, at
  // 125% on 2x, measured in Chromium), and the stroke's butt end on the
  // window edge falls a device row from the ring's end at 2x (skipped). A
  // missing, doubled or squared corner differs by the stroke's contrast
  // along its whole arc: some 20 pixels a corner at 1x, 130 at 125% on 2x.
  const end = { y0: base + radius - g.dpr, y1: base + radius + g.dpr };
  const corners = await maxDifference(page, actual, reference, [
    { x0: 0, x1: corner, y0: base - g.dpr, y1: base + corner, skip: [...hole, { x0: 0, x1: 2 * g.dpr, ...end }] },
    { x0: width - corner, x1: width, y0: base - g.dpr, y1: base + corner, skip: [...hole, { x0: width - 2 * g.dpr, x1: width, ...end }] },
  ], 6);
  expect(corners.max, `${what}: the outline's corners vs a CSS border round the surface, worst ${corners.at}`).toBeLessThanOrEqual(16);
  expect(corners.over, `${what}: pixels of the outline's corners off a CSS border by more than 6`).toBeLessThanOrEqual(16 * g.dpr * g.dpr);
}

/**
 * The surface's outline drawn by CSS alone: the tab's stroke hidden, and a
 * box below the strip base, edge to edge and one corner radius tall (at
 * least a pixel), with a 1px border in the outline's colour on its top (and
 * sides, when the corners are rounded) and the surface's radius on its top
 * corners, so its border is the top edge and the two corner arcs (the outline
 * ends where each arc meets the window's side). Its top sits at the strip's
 * base: the title bar's bottom, or a row above it in Default (#1856).
 */
async function shotWithSurfaceBorder(page: Page): Promise<string> {
  const g = await geometry(page);
  // The strip's base sits in the bar's last row at most (#1856).
  expect(g.titlebar.bottom - g.base, "the strip base is at the title bar's bottom").toBeGreaterThanOrEqual(-0.5);
  expect(g.titlebar.bottom - g.base, "the strip base is at the title bar's bottom").toBeLessThanOrEqual(1.5);
  await page.locator('[data-region="titlebar"]').evaluate((bar, { color, top, radius }) => {
    const box = document.createElement("div");
    box.id = "surface-border-reference";
    // Plain lengths: WebKit zooms a registered custom length twice when a
    // border radius reads it under CSS zoom.
    // Square corners (Default) have no arcs, so no sides: the top edge alone.
    const sides = radius > 0 ? 1 : 0;
    box.style.cssText = `position: absolute !important; left: 0; right: 0; top: ${top}px; height: ${Math.max(radius, 1)}px; box-sizing: border-box; border: solid ${color}; border-width: 1px ${sides}px 0; border-radius: ${radius}px ${radius}px 0 0; z-index: 3; pointer-events: none;`;
    bar.appendChild(box);
  }, { color: g.outlineColor, top: (g.base - g.titlebar.top) / g.zoom, radius: g.surfaceRadius / g.zoom });
  try {
    return await shotWith(page, '[data-region="tab-edge"] { visibility: hidden !important; }');
  } finally {
    await page.locator("#surface-border-reference").evaluate((el) => el.remove());
    await settle(page);
  }
}

/**
 * Islands: every island keeps its own outline (#1785). Its top edge, its top
 * corners and the sides below them read exactly as without the tab's layers,
 * wherever the tab stands, so nothing the tab draws (hole, pockets, outline,
 * shadows) reaches an island, and no island is opened or squared under it.
 */
async function expectIslands(page: Page, what: string): Promise<void> {
  const g = await geometry(page);
  expect(g.islands.length, `${what}: islands`).toBeGreaterThanOrEqual(2);
  const actual = await shot(page);
  const reference = await shotWith(page, NO_TAB_LAYERS);
  const regions: Region[] = g.islands.map((island) => {
    const top = snap(g, island.top);
    const corner = Math.ceil(island.radius * g.dpr) + 4 * g.dpr;
    return { x0: snap(g, island.left) - 2 * g.dpr, x1: snap(g, island.right) + 2 * g.dpr, y0: top - 2 * g.dpr, y1: top + corner };
  });
  const { max, at } = await maxDifference(page, actual, reference, regions);
  expect(max, `${what}: islands vs drawn without the tab, worst ${at}`).toBeLessThanOrEqual(4);
}

/**
 * Foot: the tab and its surface are one (#1785). With Floating Islands'
 * islands hidden (their shadows reach up toward the base by design), or
 * Default's contents hidden (its sidebar and panes are the surface itself,
 * #1856), under the tab's
 * straight body every row from one above the base to four below it reads as
 * the tab body just above (same column): no edge, shade or shadow crosses
 * the base as a band or hairline (#1734 real-Mac capture: a 3px band with
 * the material, a 1px hairline two rows down without it).
 */
async function expectFoot(page: Page, cell: Cell, what: string): Promise<void> {
  const g = await geometry(page);
  if (!g.tab || !g.hole) return;
  // The tab's painted body: its hole less the fillets. A sliding tab is
  // narrower than its box (it is revealed by its own clip).
  const fillet = 14 * g.zoom;
  const body = { left: g.hole[0] + fillet, right: g.hole[1] - fillet };
  if (body.right - body.left < 6) return;
  const image = await shotWith(page, cell.layout === "floating-islands" ? NO_ISLANDS : SURFACE_ONLY);
  const result = await page.evaluate(async ({ data, tab, dpr, seam }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const D = context.getImageData(0, 0, image.width, image.height);
    let worst = { d: 0, at: "" };
    const differs = (i: number, ref: number) => Math.max(...[0, 1, 2].map((k) => Math.abs(D.data[i + k] - D.data[ref + k])));
    for (let x = Math.ceil((tab.left + 2) * dpr); x < Math.floor((tab.right - 2) * dpr); x++) {
      const ref = ((seam - 3 * dpr) * D.width + x) * 4;
      for (let y = seam - dpr; y < seam + 5 * dpr; y++) {
        const i = (y * D.width + x) * 4;
        const d = differs(i, ref);
        if (d > worst.d) worst = { d, at: `(${x},${y}) ${[0, 1, 2].map((k) => D.data[i + k])} vs body ${[0, 1, 2].map((k) => D.data[ref + k])}` };
      }
    }
    return worst;
  }, { data: image, tab: body, dpr: g.dpr, seam: snap(g, g.tab.bottom) });
  // Up to 3: the surface's gradients dither by up to 2 a row, plus the
  // simulated wallpaper's own gradient.
  expect(result.d, `${what}: rows across the base under the tab vs its body, worst ${result.at}`).toBeLessThanOrEqual(3);
}

/** Shade: hiding the strip shade changes nothing below the strip's base. */
async function expectShadeInBar(page: Page, what: string): Promise<void> {
  const g = await geometry(page);
  const base = snap(g, g.base);
  const actual = await shot(page);
  const without = await shotWith(page, '[data-region="tab-key-shadow"] .strip-shade { display: none !important; }');
  const { max, at } = await maxDifference(page, actual, without, [{ x0: 0, x1: Math.round(g.titlebar.width * g.dpr), y0: base, y1: base + 20 * g.dpr }]);
  expect(max, `${what}: strip shade below the base, worst ${at}`).toBeLessThanOrEqual(1);
}

/**
 * Pockets: below the base, the strip shade wraps round the surface's top
 * corners and nowhere else. Hiding the pockets changes nothing below the
 * base outside the two corner squares, and darkens or tints each square
 * (with the islands hidden, so the comparison sees the surface alone).
 */
async function expectPockets(page: Page, what: string): Promise<void> {
  const g = await geometry(page);
  const base = snap(g, g.base);
  const width = Math.round(g.titlebar.width * g.dpr);
  const corner = Math.ceil(g.surfaceRadius * g.dpr) + g.dpr;
  const actual = await shotWith(page, NO_ISLANDS);
  const without = await shotWith(page, `${NO_ISLANDS} [data-region="tab-key-shadow"] .surface-pockets { display: none !important; }`);
  const squares = [{ x0: 0, x1: corner, y0: base, y1: base + corner }, { x0: width - corner, x1: width, y0: base, y1: base + corner }];
  const outside = await maxDifference(page, actual, without, [{ x0: 0, x1: width, y0: base, y1: base + 20 * g.dpr, skip: squares }]);
  expect(outside.max, `${what}: pockets outside the corners, worst ${outside.at}`).toBeLessThanOrEqual(1);
  for (const square of squares) {
    const inside = await maxDifference(page, actual, without, [square]);
    expect(inside.max, `${what}: a pocket shades the corner at x=${square.x0}`).toBeGreaterThanOrEqual(6);
  }
}

/** Shadow: darkening by the tab's shadows on each side, as a share of the strip's luminance. */
async function expectShadow(page: Page, what: string): Promise<void> {
  const g = await geometry(page);
  if (!g.tab) return;
  const lift = await page.locator('[data-region="tab-key-shadow"] .tab-lift').getAttribute("d");
  expect((lift?.match(/M/g) ?? []).length, `${what}: one tab casts the shadow`).toBe(1);
  const actual = await shot(page);
  const without = await shotWith(page, '[data-region="tab-key-shadow"] .tab-shadows { display: none !important; }');
  // The painted tab: its hole less the fillets (a sliding tab is revealed by its own clip).
  const fillet = 14 * g.zoom;
  const tab = g.hole ? { ...g.tab, left: g.hole[0] + fillet, right: g.hole[1] - fillet } : g.tab;
  if (tab.right - tab.left < 12) return;
  const result = await page.evaluate(async ({ a, b, tab, dpr, base }) => {
    const load = async (data: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height);
    };
    const [A, B] = [await load(a), await load(b)];
    const L = (I: ImageData, x: number, y: number) => {
      const i = (Math.round(y * dpr) * I.width + Math.round(x * dpr)) * 4;
      return 0.299 * I.data[i] + 0.587 * I.data[i + 1] + 0.114 * I.data[i + 2];
    };
    const dark = (x: number, y: number) => L(B, x, y) - L(A, x, y);
    const ys = [0.35, 0.5, 0.65].map((f) => tab.top + (tab.bottom - tab.top) * f);
    const xs = [0.3, 0.5, 0.7].map((f) => tab.left + (tab.right - tab.left) * f);
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    const side = (at: (d: number, v: number) => [number, number], values: number[]) =>
      Math.max(...[1, 2, 3, 4].map((d) => mean(values.map((v) => dark(...at(d, v))))));
    let below = 0;
    for (let y = base; y < base + 4; y++) {
      for (let x = Math.floor((tab.left - 30) * dpr); x < Math.ceil((tab.right + 30) * dpr); x++) {
        const i = (y * A.width + x) * 4;
        below = Math.max(below, Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      }
    }
    return {
      left: side((d, y) => [tab.left - d, y], ys),
      right: side((d, y) => [tab.right + d - 1 / dpr, y], ys),
      top: side((d, x) => [x, tab.top - d], xs),
      strip: L(B, tab.left - 6, ys[1]),
      below,
    };
  }, { a: actual, b: without, tab, dpr: g.dpr, base: snap(g, g.tab.bottom) });
  const floor = Math.max(1.5, result.strip * 0.04);
  const detail = `${what}: ${JSON.stringify(result)}`;
  expect(result.left, `left flank ${detail}`).toBeGreaterThanOrEqual(floor);
  expect(result.top, `top edge ${detail}`).toBeGreaterThanOrEqual(floor);
  expect(result.right, `right flank ${detail}`).toBeGreaterThanOrEqual(result.left * 1.6);
  expect(result.below, `below the base ${detail}`).toBeLessThanOrEqual(1);
}

/**
 * Backdrop: with the material on, the strip shows the window's backdrop.
 * In every cell the outline, island and foot checks hold again over a
 * contrasting backdrop, so no tab layer lets the backdrop bleed through or
 * tints it.
 */
async function expectBackdrop(page: Page, cell: Cell, what: string): Promise<void> {
  const g = await geometry(page);
  if (cell.material) {
    const actual = await shot(page);
    const other = await shotWith(page, OTHER_BACKDROP);
    const strip = { x0: 0, x1: Math.round(g.titlebar.width * g.dpr), y0: 0, y1: snap(g, g.titlebar.bottom) };
    const { max } = await maxDifference(page, actual, other, [strip]);
    expect(max, `${what}: the material shows through the strip`).toBeGreaterThan(8);
  }
  const tag = await page.addStyleTag({ content: OTHER_BACKDROP });
  await settle(page);
  await expectOutline(page, `${what} over another backdrop`);
  if (cell.layout === "floating-islands") await expectIslands(page, `${what} over another backdrop`);
  await expectFoot(page, cell, `${what} over another backdrop`);
  await tag.evaluate((el) => el.remove());
  await settle(page);
}

/**
 * Default is flat (#1856): its surface's corners are square, so there are no
 * shade pockets below the base, and the tab casts no shadow.
 */
async function expectFlat(page: Page, what: string): Promise<void> {
  await expect(page.locator('[data-region="tab-key-shadow"] .surface-pockets'), `${what}: no pockets`).toHaveAttribute("d", "");
  await expect(page.locator('[data-region="tab-key-shadow"] .tab-shadows'), `${what}: no tab shadow`).toHaveCSS("display", "none");
}

/**
 * Floating Islands' outline follows its layout contract: the marks draw the
 * surface's corners at --layout-radius and stroke the outline in the
 * islands' border colour (the outline check compares against both).
 */
async function expectIslandsOutlineContract(page: Page, what: string): Promise<void> {
  const contract = await page.evaluate(() => {
    const bar = document.querySelector('[data-region="titlebar"]')!;
    const probe = document.createElement("div");
    probe.style.cssText = "position: absolute; border: var(--layout-border);";
    bar.appendChild(probe);
    const style = getComputedStyle(bar);
    const result = {
      border: getComputedStyle(probe).borderTopColor,
      layoutRadius: style.getPropertyValue("--layout-radius").trim(),
      surfaceRadius: style.getPropertyValue("--islands-surface-radius").trim(),
    };
    probe.remove();
    return result;
  });
  const g = await geometry(page);
  expect(g.outlineColor, `${what}: the outline is the islands' border colour`).toBe(contract.border);
  expect(parseFloat(contract.surfaceRadius), `${what}: the surface's corners follow --layout-radius (${JSON.stringify(contract)})`).toBeCloseTo(parseFloat(contract.layoutRadius), 1);
}

async function expectStatic(page: Page, cell: Cell, what: string): Promise<void> {
  await expectOutline(page, what);
  await expectFoot(page, cell, what);
  await expectShadeInBar(page, what);
  if (cell.layout === "floating-islands") {
    await expectIslandsOutlineContract(page, what);
    await expectIslands(page, what);
    await expectPockets(page, what);
    await expectShadow(page, what);
  } else {
    await expectFlat(page, what);
  }
}

/** Animation time per stepped frame; the slide runs 180ms. */
const STEP_MS = 15;

/**
 * Run `action` with the title bar's animations held and step them, as
 * `steppedFrames` does, to `fraction` of the slide: every animation and
 * transition advanced by the same animation time, so the frame is one the
 * app really paints. Pausing at a wall-clock moment instead caught a
 * transition WebKit started a frame late at its start beside a slide
 * already 15% in.
 */
async function freezeAt(page: Page, action: () => Promise<void>, fraction: number): Promise<void> {
  const frames = await steppedFrames(page, action, { stepMs: STEP_MS, steps: Math.round((fraction * 180) / STEP_MS) });
  expect(frames.length, "frames stepped").toBeGreaterThan(1);
  // Held transitions still creep in stretched real time: pause them, or the
  // reference screenshots below would see a different frame. WebKit's first
  // screenshot then moves the paused strip (~10px, measured), so take it
  // before measuring, and have the marks (whose frame loop stops with the
  // animations) follow the frozen layout.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if ((animation.effect as KeyframeEffect | null)?.target?.closest?.('[data-region="titlebar"]')) animation.pause();
    }
  });
  await page.screenshot();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await settle(page);
}

async function framesOf(page: Page, cell: Cell, what: string, action: () => Promise<void>, zoom = 100): Promise<void> {
  // A frozen animation never finishes: each fraction starts afresh.
  for (const fraction of [0.15, 0.5, 0.85]) {
    await openCell(page, cell, { count: 3, zoom });
    await freezeAt(page, action, fraction);
    await expectStatic(page, cell, `${what} at ${fraction}`);
    await expectBackdrop(page, cell, `${what} at ${fraction}`);
  }
}

const openTab = (page: Page) => () => pressShortcut(page, "t", { ctrlKey: true });
const closeTab = (page: Page) => () => page.locator('.tab-viewport .tab.active .tab-close').click();

for (const cell of CELLS) {
  test.describe(`Tab outline matrix: ${label(cell)} (#1734, #1785)`, () => {
    // 1x explicitly: the WebKit project otherwise renders at 2x (covered below).
    test.use({ deviceScaleFactor: 1 });
    test.describe.configure({ timeout: 120_000 });
    test("at rest with 1, 3 and 12 tabs, and on hover", async ({ page }) => {
      for (const count of [1, 3, 12]) {
        await openCell(page, cell, { count, active: count === 12 ? 9 : Math.min(count - 1, 1) });
        await expectStatic(page, cell, `${count} tabs`);
        await expectBackdrop(page, cell, `${count} tabs`);
      }
      // Hover an inactive tab and the active one: neither changes the outline,
      // the shade or the shadow.
      await openCell(page, cell, { count: 3 });
      const tabs = page.locator('.tab-viewport [data-region="tab"]');
      for (const index of [0, 1]) {
        await tabs.nth(index).hover();
        await settle(page);
        await expectStatic(page, cell, `hover tab ${index}`);
      }
    });

    // Three held frames per slide, not every frame: the matrix already costs
    // minutes per engine (stepped frames: floating-islands.spec.ts).
    test("opening and closing a tab, held at 15%, 50% and 85% of the slide", async ({ page }) => {
      await framesOf(page, cell, "opening", openTab(page));
      await framesOf(page, cell, "closing", closeTab(page));
    });
  });
}

test.describe("Tab outline matrix at 125% zoom on a 2x display (#1734, #1785)", () => {
  test.use({ deviceScaleFactor: 2 });
  test.describe.configure({ timeout: 120_000 });
  for (const cell of CELLS) {
    test(`at rest, opening and closing: ${label(cell)}`, async ({ page }) => {
      await openCell(page, cell, { count: 3, zoom: 125 });
      await expectStatic(page, cell, "125% 2x");
      await expectBackdrop(page, cell, "125% 2x");
      for (const [what, action] of [["opening", openTab(page)], ["closing", closeTab(page)]] as const) {
        await openCell(page, cell, { count: 3, zoom: 125 });
        await freezeAt(page, action, 0.5);
        await expectStatic(page, cell, `125% 2x ${what} at 0.5`);
      }
    });
  }
});
