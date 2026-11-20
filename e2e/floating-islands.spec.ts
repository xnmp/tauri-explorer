/**
 * Floating Islands layout on any platform (#277, #1306).
 *
 * Selecting the Floating Islands layout must apply the island arrangement
 * without any native backdrop: the layout base attribute is set, the native
 * backdrop capability is not, and the sidebar renders as a rounded island
 * over an opaque window.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, pressShortcut, seedSettings, waitForEntries } from "./helpers";
import { expectSeededGrowth, steppedFrames, steppedFramesOfNewTab, TAB_SEED_MAX, type TabFrame } from "./tab-frames";

test.describe("Floating islands (#277)", () => {
  test("selecting the layout applies islands without a native backdrop", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    await applySettingsAndReload(page, { layoutTheme: "floating-islands" });
    await waitForEntries(page);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-layout-base", "floating-islands");
    await expect(html).not.toHaveAttribute("data-native-backdrop");

    // The sidebar renders as a rounded island (non-zero radius) over an
    // opaque body: without native material nothing may be see-through.
    const radius = await page
      .locator(".sidebar-container")
      .evaluate((el) => getComputedStyle(el).borderRadius);
    expect(parseFloat(radius)).toBeGreaterThan(0);
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).not.toBe("rgba(0, 0, 0, 0)");

    await applySettingsAndReload(page, { layoutTheme: "default" });
    await waitForEntries(page);
    await expect(html).toHaveAttribute("data-layout-base", "default");
    const flatRadius = await page
      .locator(".sidebar-container")
      .evaluate((el) => getComputedStyle(el).borderRadius);
    expect(parseFloat(flatRadius)).toBe(0);
  });
});

/**
 * #1734, #1785: under Floating Islands the active tab owns the whole window
 * below the strip. The tab is a hole in the strip shade through which the
 * window body (the tab's surface) shows; that surface runs edge to edge with
 * rounded top corners, and every island sits on it with its own outline. The
 * one outline is the tab plus the surface's top edge. Inline SVG marks follow
 * the tab every frame of a slide.
 */
test.describe("Active tab owns the window (#1734, #1785)", () => {
  // Stepped slides sample 23 frames each: up to 26s on a WebKit CI container,
  // over the default budget on a loaded one (#1775).
  test.describe.configure({ timeout: 60_000 });
  const SIMULATED_MATERIAL = `
    html {
      background:
        linear-gradient(rgba(128, 128, 128, 0.55), rgba(128, 128, 128, 0.55)),
        radial-gradient(70% 90% at 15% 20%, #e8875a 0%, transparent 60%),
        radial-gradient(60% 80% at 85% 75%, #3f7fd6 0%, transparent 65%),
        linear-gradient(135deg, #5b3c88, #1f6f6b) !important;
      background-attachment: fixed !important;
    }`;
  const PATHS = ["/home/user", "/home/user/Downloads", "/home/user/Documents"];

  async function openIslands(page: Page, { theme = "dark", material = false, count = 3, layout = "floating-islands", active = count - 1, settings = {} as Record<string, unknown>, width = 1100 } = {}): Promise<void> {
    await page.setViewportSize({ width, height: 600 });
    if (material) {
      await page.addInitScript(() => {
        Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel", configurable: true });
      });
    }
    await seedSettings(page, {
      layoutTheme: layout,
      theme,
      showWindowControls: true,
      tabTitleGitRoot: false,
      ...(material ? { translucency: true } : {}),
      ...settings,
    });
    // The last tab is active: with three it stands over the panes island.
    await page.addInitScript(({ paths, count, active }) => {
      localStorage.setItem("explorer-tabs", JSON.stringify({
        version: 3,
        tabs: Array.from({ length: count }, (_, i) => ({ id: `fused-${i}`, kind: "explorer", activePaneId: `fused-pane-${i}`, layout: { type: "leaf", id: `fused-pane-${i}`, path: paths[i % paths.length] } })),
        activeTabId: `fused-${active}`,
      }));
    }, { paths: PATHS, count, active });
    await page.goto("/");
    await waitForEntries(page);
    if (material) {
      await expect(page.locator("html")).toHaveAttribute("data-material", "vibrancy");
      await page.addStyleTag({ content: SIMULATED_MATERIAL });
    }
    // The lazily loaded marks have drawn the active tab's hole.
    if (layout === "floating-islands") await expect(page.locator('[data-region="titlebar"]')).toHaveAttribute("data-tab-hole", /\d/);
  }

  /** Every island (each draws its own outline, radius and shadow) and the status bar: all sit on the tab's surface. */
  const ISLANDS = '[data-region="sidebar"], [data-region="panes"], [data-region="preview"], [data-region="miller-island"], [data-region="status-bar"], [data-region="terminal"]';

  /** Run `read` with the islands hidden, so only the window body (the tab's surface) and the strip paint. */
  async function withIslandsHidden<T>(page: Page, read: () => Promise<T>): Promise<T> {
    const tag = await page.addStyleTag({ content: `${ISLANDS} { visibility: hidden !important; }` });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    try {
      return await read();
    } finally {
      await tag.evaluate((el) => el.remove());
    }
  }

  /** RGB pixels of a page region at device scale 1, row-major. */
  async function pixels(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number[][]> {
    const png = await page.screenshot({ clip, animations: "disabled" });
    return page.evaluate(async ({ data, width, height }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0, width, height);
      const raw = context.getImageData(0, 0, width, height).data;
      const out: number[][] = [];
      for (let i = 0; i < raw.length; i += 4) out.push([raw[i], raw[i + 1], raw[i + 2]]);
      return out;
    }, { data: png.toString("base64"), width: clip.width, height: clip.height });
  }

  const distance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  async function activeTabBox(page: Page) {
    return (await page.locator('.tab-viewport [data-region="tab"][aria-selected="true"]').boundingBox())!;
  }

  for (const theme of ["light", "dark"]) {
    for (const material of [false, true]) {
      test(`the tab wears the window's surface, with no seam or sliver (${theme}, ${material ? "macOS material" : "opaque"})`, async ({ page }) => {
        await openIslands(page, { theme, material });
        const tab = await activeTabBox(page);
        const base = Math.round(tab.y + tab.height);
        const left = Math.round(tab.x);
        const right = Math.round(tab.x + tab.width);

        // The tab's lower sides, inside the flare, are one surface: no
        // light or dark column where the tab meets its fillets.
        for (const x of [left - 1, right - 4]) {
          const region = await pixels(page, { x, y: base - 6, width: 5, height: 5 });
          const reference = region[region.length - 1];
          for (const pixel of region) expect(distance(pixel, reference)).toBeLessThanOrEqual(12);
        }

        // The tab and the surface below the strip base are one, with the
        // islands (8px below the base, their shadows reaching up) in place.
        const center = Math.round(tab.x + tab.width / 2);
        const [above] = await pixels(page, { x: center, y: base - 3, width: 1, height: 1 });
        const [below] = await pixels(page, { x: center, y: base + 3, width: 1, height: 1 });
        expect(distance(above, below)).toBeLessThanOrEqual(10);

        // The tab's body is the window body: with the islands hidden, the
        // column from inside the tab down across the base into the surface
        // under it is one flat colour (gradient dithering moves it by up to
        // 2), so no line, band or sliver marks the base, and it is the
        // colour the tab shows with the islands in place (their shadows
        // reach up into the tab by up to 4).
        const column = await withIslandsHidden(page, () => pixels(page, { x: center, y: base - 3, width: 1, height: 24 }));
        for (const [row, pixel] of column.entries()) {
          expect(distance(pixel, column[0]), `surface ${row - 3}px under the base`).toBeLessThanOrEqual(3);
        }
        expect(distance(column[0], above), "the tab shows the window body").toBeLessThanOrEqual(6);

        // The rest of the strip is shaded, so the tab stands out of it.
        // Opaque: clearly darker, a luminance step of at least 12 (of 255;
        // the default dark theme measures ~15, light ~35). Over the material
        // the tab is the window body's light tint over the wallpaper and the
        // strip a heavier shade over it: they differ (by ~25 light, ~55 dark
        // over the simulated wallpaper), though a light shade over that
        // mid-grey stand-in lightens rather than darkens it.
        const [strip] = await pixels(page, { x: 8, y: Math.round(tab.y) + 2, width: 1, height: 1 });
        if (material) expect(distance(above, strip)).toBeGreaterThanOrEqual(8);
        else expect(luminance(above) - luminance(strip)).toBeGreaterThanOrEqual(12);

        if (material) {
          await page.screenshot({ path: `screenshots/feat/islands-tab-owns-window/islands-${theme}.png`, animations: "disabled" });
        }
      });
    }
  }

  // The surface's top corners are rounded (#1785): outside each, below the
  // base, the strip shade wraps round it; inside, the surface shows.
  for (const theme of ["light", "dark"]) {
    for (const material of [false, true]) {
      test(`the surface's top corners are rounded (${theme}, ${material ? "macOS material" : "opaque"})`, async ({ page }) => {
        await openIslands(page, { theme, material });
        const tab = await activeTabBox(page);
        const base = Math.round(tab.y + tab.height);
        const width = page.viewportSize()!.width;
        const one = async (x: number, y: number) => (await pixels(page, { x, y, width: 1, height: 1 }))[0];
        // Mirrored sample points, `inset` from the window's left or right
        // edge and `dy` below the base. The corner's radius is 14px: (1, 1)
        // and (2, 2) lie outside its arc, (6, 6) inside it.
        const sample = (side: "left" | "right") => {
          const at = (inset: number, dy: number) => one(side === "left" ? inset : width - 1 - inset, base + dy);
          return Promise.all([at(1, 1), at(2, 2), at(1, -3), at(6, 6), at(1, 20), at(18, 2)]);
        };
        const { body, corners } = await withIslandsHidden(page, async () => ({
          body: await one(Math.round(tab.x + tab.width / 2), base + 3),
          corners: { left: await sample("left"), right: await sample("right") },
        }));
        for (const [side, [pocket, pocketInner, strip, diagonal, below, beside]] of Object.entries(corners)) {
          // The pocket is the strip shade just above it.
          expect(distance(pocket, strip), `${side} pocket vs the strip`).toBeLessThanOrEqual(6);
          expect(distance(pocketInner, pocket), `${side} pocket`).toBeLessThanOrEqual(3);
          // Inside the arc, down the window's side and along the top edge
          // past the corner: the surface, not the shade.
          for (const [where, pixel] of [["inside the arc", diagonal], ["below the corner", below], ["past the corner", beside]] as const) {
            expect(distance(pixel, pocket), `${side} ${where} is not shade`).toBeGreaterThanOrEqual(8);
            // Opaque, the surface is the tab's colour, give or take its
            // depth gradient (~9 over these 20px); over the material it shows
            // the wallpaper, which varies across the window.
            if (!material) expect(distance(pixel, body), `${side} ${where} is the tab's surface`).toBeLessThanOrEqual(12);
          }
        }
      });
    }
  }

  /** Frames of a Ctrl+T slide, from the first that shows the new tab. */
  async function slideFrames(page: Page): Promise<TabFrame[]> {
    await page.waitForTimeout(300);
    const frames = await steppedFramesOfNewTab(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    expect(frames.length).toBeGreaterThanOrEqual(4);
    return frames;
  }

  test("the hole and the outline follow a sliding tab frame by frame", async ({ page }) => {
    await openIslands(page);
    for (const frame of await slideFrames(page)) {
      const { active, hole, edge, outline } = frame;
      expect(active, `t=${frame.t}`).not.toBeNull();
      const expected = [active!.left - active!.fillet, active!.right + active!.fillet];
      expect(hole, `hole t=${frame.t}`).not.toBeNull();
      expect(Math.abs(hole![0] - expected[0]), `hole left t=${frame.t}`).toBeLessThanOrEqual(0.6);
      expect(Math.abs(hole![1] - expected[1]), `hole right t=${frame.t}`).toBeLessThanOrEqual(0.6);
      // The one outline runs over this frame's tab, and on along the
      // surface's top edge to both window edges.
      expect(outline, `outline t=${frame.t}`).toEqual({ top: true, left: true, right: true });
      expect(edge, `edge t=${frame.t}`).not.toBeNull();
      expect(edge![0], `edge left t=${frame.t}`).toBeLessThanOrEqual(1);
      expect(edge![1], `edge right t=${frame.t}`).toBeGreaterThanOrEqual(frame.titlebarWidth - 1);
    }
  });

  test("opening a tab keeps the whole strip shaded every frame", async ({ page }) => {
    await openIslands(page);
    for (const frame of await slideFrames(page)) {
      expect(frame.shade, `t=${frame.t}`).not.toBeNull();
      expect(frame.shade![0], `t=${frame.t}`).toBeLessThanOrEqual(0.5);
      expect(frame.shade![1], `t=${frame.t}`).toBeGreaterThanOrEqual(frame.titlebarWidth - 0.5);
    }
  });

  test("a new active tab has whole fillets from its first frame", async ({ page }) => {
    await openIslands(page);
    for (const { t, active } of await slideFrames(page)) {
      expect(active!.fillet, `t=${t}`).toBeCloseTo(14, 0);
    }
  });

  for (const count of [3, 8]) test(`first frames: the new tab grows from its seed and no tab snaps (${count} tabs)`, async ({ page }) => {
    // Eight tabs compress: the others ease to their narrower width while the
    // new tab grows, never in one frame.
    await openIslands(page, { count });
    await page.waitForTimeout(300);
    const all = await steppedFrames(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    expectSeededGrowth(all.filter((frame) => frame.widths.length > count));
    // The strip stays in place: a seed the others have not yet made room for
    // must not overflow and scroll every tab sideways. Only the strip's start
    // may move (it gives a narrower window's tabs room back, #1734), and it
    // glides with the slide: no step covers more than half its move.
    const offset = (frame: TabFrame) => frame.firstLeft! - frame.stripStart;
    for (const frame of all) expect(Math.abs(offset(frame) - offset(all[0])), `first tab t=${frame.t}`).toBeLessThanOrEqual(0.5);
    const move = Math.abs(all[all.length - 1].stripStart - all[0].stripStart);
    for (let index = 1; index < all.length; index++) {
      const step = Math.abs(all[index].stripStart - all[index - 1].stripStart);
      expect(step, `strip start t=${all[index].t} of ${move.toFixed(1)}`).toBeLessThanOrEqual(Math.max(1, move * 0.5));
    }
    // The existing tabs (indices below `count`) ease to their new width:
    // no 15ms step, including the one the new tab appears in, covers more
    // than half of a tab's whole change (a snap covers all of it). On the
    // frame the new tab appears at its seed, every tab may also give up its
    // share of that seed (flex-shrink, window-tab-bar.css) and take it back
    // as the strip makes room.
    const seedShare = (TAB_SEED_MAX + 1) / (count + 1);
    for (let i = 0; i < count; i++) {
      const change = Math.abs(all[all.length - 1].widths[i] - all[0].widths[i]);
      for (let index = 1; index < all.length; index++) {
        const step = Math.abs(all[index].widths[i] - all[index - 1].widths[i]);
        expect(step, `tab ${i} t=${all[index].t} of ${change.toFixed(1)}`).toBeLessThanOrEqual(Math.max(1, change * 0.5, seedShare));
      }
    }
  });

  test("closing a tab: the others widen with its slide and no tab snaps", async ({ page }) => {
    // Five tabs in the islands strip are narrower than their maximum, so
    // the survivors widen into the closed tab's room: over its slide, never
    // in one frame, while the strip (and "+") only moves left.
    await openIslands(page, { count: 5 });
    await page.waitForTimeout(300);
    const all = await steppedFrames(page, () => pressShortcut(page, "w", { ctrlKey: true, shiftKey: true }));
    await expect(page.locator('.tab-viewport [data-region="tab"]')).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const change = Math.abs(all[all.length - 1].widths[i] - all[0].widths[i]);
      expect(change, `tab ${i} widens`).toBeGreaterThan(4);
      for (let index = 1; index < all.length; index++) {
        const step = Math.abs(all[index].widths[i] - all[index - 1].widths[i]);
        expect(step, `tab ${i} t=${all[index].t} of ${change.toFixed(1)}`).toBeLessThanOrEqual(Math.max(1, change * 0.5));
      }
    }
    for (let index = 1; index < all.length; index++) {
      expect(all[index].plusLeft!, `+ t=${all[index].t}`).toBeLessThanOrEqual(all[index - 1].plusLeft! + 0.5);
    }
  });

  /**
   * Exactly one tab reads as the active one on every frame, from the frame
   * before the action on: it is selected, wide enough to show its icon, and
   * owns the window (the hole and the full-strength outline both sit on it).
   * A frame where no tab, or two, own the window fails, as does a frame
   * where the owner is an empty sliver.
   */
  function expectOneActiveTab(frames: TabFrame[]) {
    for (const frame of frames) {
      const at = `t=${frame.t}`;
      expect(frame.selectedCount, `selected ${at}`).toBe(1);
      const { active, hole } = frame;
      expect(active!.width, `active width ${at}`).toBeGreaterThanOrEqual(28);
      expect(frame.iconOpacity, `icon ${at}`).toBeGreaterThanOrEqual(0.99);
      const expected = [active!.left - active!.fillet, active!.right + active!.fillet];
      expect(active!.fillet, `fillet ${at}`).toBeGreaterThanOrEqual(13);
      expect(Math.abs(hole![0] - expected[0]), `hole left ${at}`).toBeLessThanOrEqual(0.6);
      expect(Math.abs(hole![1] - expected[1]), `hole right ${at}`).toBeLessThanOrEqual(0.6);
      expect(frame.edgeOpacity, `edge ${at}`).toBeGreaterThanOrEqual(0.99);
      expect(frame.outline, `outline over the tab ${at}`).toEqual({ top: true, left: true, right: true });
    }
  }

  for (const count of [3, 8]) test(`opening a tab: the new tab owns the window from its first frame (${count} tabs)`, async ({ page }) => {
    await openIslands(page, { count });
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    await expect(page.locator('.tab-viewport [data-region="tab"]')).toHaveCount(count + 1);
    expectOneActiveTab(frames);
    // The new (last) tab is the active one from the first frame after Ctrl+T.
    for (const frame of frames.slice(1)) expect(frame.activeIndex, `t=${frame.t}`).toBe(count);
  });

  // At 125% zoom on a 2× display the hole and outline are still measured and
  // drawn in the tab's own CSS space from the first frame (#1744 review: a
  // sheet captured with screenshots between WebKit steps showed it offset;
  // without them it tracks the tab).
  test.describe("at 125% zoom on a 2x display", () => {
    test.use({ deviceScaleFactor: 2 });
    test("opening a tab: the new tab owns the window from its first frame", async ({ page }) => {
      await openIslands(page, { theme: "light", settings: { zoomLevel: 125 } });
      await page.waitForTimeout(300);
      const frames = await steppedFrames(page, () => pressShortcut(page, "t", { ctrlKey: true }));
      await expect(page.locator('.tab-viewport [data-region="tab"]')).toHaveCount(4);
      expectOneActiveTab(frames);
      for (const frame of frames.slice(1)) expect(frame.activeIndex, `t=${frame.t}`).toBe(3);
    });
  });

  // WKWebView places a composited island a fraction of a pixel off the device
  // grid under an ancestor that clips one axis only, resampling its content
  // soft (real-Mac capture, #1744). Local engines do not show it, so pin the
  // clipping contract the fix relies on.
  test("no ancestor of an island clips one axis only, and the window clips", async ({ page }) => {
    await openIslands(page, { material: true, theme: "light" });
    const clips = await page.locator('[data-region="panes"]:visible').first().evaluate((island) => {
      const out: { node: string; x: string; y: string }[] = [];
      for (let el = island.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        out.push({ node: `${el.tagName.toLowerCase()}${el.dataset.region ? `[${el.dataset.region}]` : ""}`, x: style.overflowX, y: style.overflowY });
      }
      return out;
    });
    for (const { node, x, y } of clips) expect(x, `${node} clips one axis`).toBe(y);
    expect(clips.find((c) => c.node === "main[app]")).toEqual({ node: "main[app]", x: "clip", y: "clip" });
  });

  test("closing the active tab hands the window to its neighbour in the same frame", async ({ page }) => {
    await openIslands(page);
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "w", { ctrlKey: true, shiftKey: true }));
    await expect(page.locator('.tab-viewport [data-region="tab"]')).toHaveCount(2);
    expectOneActiveTab(frames);
  });

  test("switching tabs by click and Ctrl+Tab moves the hole and outline in the same frame", async ({ page }) => {
    await openIslands(page);
    await page.waitForTimeout(300);
    const first = page.locator('.tab-viewport [data-region="tab"]').first();
    expectOneActiveTab(await steppedFrames(page, () => first.click(), { steps: 8 }));
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.mouse.move(5, 400);
    expectOneActiveTab(await steppedFrames(page, () => pressShortcut(page, "Tab", { ctrlKey: true }), { steps: 8 }));
    await expect(page.locator('.tab-viewport [data-region="tab"]').nth(1)).toHaveAttribute("aria-selected", "true");
  });

  /** Strongest luminance step between any pixel of a box and its first pixel (its background). */
  async function glyphContrast(page: Page, box: { x: number; y: number; width: number; height: number }, background?: number[]) {
    const region = await pixels(page, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
    const reference = luminance(background ?? region[0]);
    return Math.max(...region.map((pixel) => Math.abs(luminance(pixel) - reference)));
  }

  // The window controls sit above the strip shade: their glyphs are as legible
  // as in the default layout (the shade once painted over them).
  for (const theme of ["light", "dark"]) test(`window control glyphs are not under the strip shade (${theme})`, async ({ page }) => {
    const measure = async (layout: string) => {
      await openIslands(page, { theme, layout });
      await page.mouse.move(5, 400);
      const contrasts: number[] = [];
      for (const button of await page.locator(".window-controls .control-btn svg").all()) {
        contrasts.push(await glyphContrast(page, (await button.boundingBox())!));
      }
      return Math.min(...contrasts);
    };
    const reference = await measure("default");
    const islands = await measure("floating-islands");
    expect(reference).toBeGreaterThan(20);
    expect(islands, `islands ${islands.toFixed(1)} vs default ${reference.toFixed(1)}`).toBeGreaterThanOrEqual(reference * 0.85);
  });

  // Hovering an inactive tab lays its pill under the title, never over it, and
  // brings the title up rather than washing it out.
  for (const layout of ["floating-islands", "default"]) for (const theme of ["light", "dark"]) test(`hovering an inactive tab brightens its title (${layout}, ${theme})`, async ({ page }) => {
    await openIslands(page, { theme, layout });
    const tab = page.locator('.tab-viewport [data-region="tab"]').first();
    const title = (await tab.locator(".tab-title").boundingBox())!;
    const sample = { x: title.x, y: title.y, width: Math.min(40, title.width), height: title.height };
    await page.mouse.move(5, 400);
    const [restBg] = await pixels(page, { x: Math.round(title.x + 2), y: Math.round(title.y - 2), width: 1, height: 1 });
    const rest = await glyphContrast(page, sample, restBg);
    await tab.hover({ position: { x: 80, y: 4 } });
    const [hoverBg] = await pixels(page, { x: Math.round(title.x + 2), y: Math.round(title.y - 2), width: 1, height: 1 });
    const hovered = await glyphContrast(page, sample, hoverBg);
    expect(hovered, `hovered ${hovered.toFixed(1)} vs rest ${rest.toFixed(1)}`).toBeGreaterThanOrEqual(rest - 2);
  });

  // The close button of a tab opening from its seed waits until the tab has
  // room for it: it never draws past the tab's edge (default layout) or
  // under its curved corner (islands).
  for (const layout of ["floating-islands", "default"]) test(`a new tab's close button never shows outside the tab (${layout})`, async ({ page }) => {
    await openIslands(page, { layout });
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    expect(frames.some((frame) => (frame.closeOpacity ?? 0) > 0.99)).toBe(true);
    for (const frame of frames) {
      if ((frame.closeOpacity ?? 0) <= 0.01) continue;
      expect(frame.closeRight!, `t=${frame.t} close at ${frame.closeRight} in tab to ${frame.active!.right}`).toBeLessThanOrEqual(frame.active!.right - 2);
    }
  });

  // A closing tab never shrinks as an empty stub: once its content has
  // faded (below 40% of its width) its own surface fades with it.
  test("a closing tab fades its surface with its content (default layout)", async ({ page }) => {
    await openIslands(page, { layout: "default" });
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "w", { ctrlKey: true, shiftKey: true }));
    const leaving = frames.filter((frame) => frame.closing);
    expect(leaving.length).toBeGreaterThanOrEqual(3);
    const start = Math.max(...leaving.map((frame) => frame.closing!.width));
    for (const { t, closing } of leaving) {
      const fraction = closing!.width / start;
      if (fraction < 0.35) expect(closing!.opacity, `t=${t} at ${(fraction * 100).toFixed(0)}%`).toBeLessThan(1);
      if (fraction < 0.1) expect(closing!.opacity, `t=${t} at ${(fraction * 100).toFixed(0)}%`).toBeLessThanOrEqual(0.3);
    }
  });

  // Titles that do not fit fade out at their right edge (no ellipsis, no
  // hard-clipped half letters), and crossing into icon-only tabs moves no
  // icon.
  for (const layout of ["floating-islands", "default"]) test(`narrow titles fade out and icons stay put (${layout})`, async ({ page }) => {
    await openIslands(page, { layout, count: 9, theme: "light" });
    await page.mouse.move(5, 400);
    const tab = page.locator('.tab-viewport [data-region="tab"]').nth(1);
    const title = (await tab.locator(".tab-title").boundingBox())!;
    expect(title.width).toBeGreaterThan(12);
    const [bg] = await pixels(page, { x: Math.round(title.x + 2), y: Math.round(title.y - 2), width: 1, height: 1 });
    const head = await glyphContrast(page, { x: title.x, y: title.y, width: Math.min(10, title.width / 2), height: title.height }, bg);
    // The last 8px hold an ellipsis at full contrast; a fade halves them.
    const tail = await glyphContrast(page, { x: title.x + title.width - 8, y: title.y, width: 8, height: title.height }, bg);
    expect(head).toBeGreaterThan(40);
    expect(tail, `tail ${tail.toFixed(1)} vs head ${head.toFixed(1)}`).toBeLessThanOrEqual(head * 0.6);

    const iconOffset = async (index: number) => {
      const box = (await page.locator('.tab-viewport [data-region="tab"]').nth(index).boundingBox())!;
      const icon = (await page.locator('.tab-viewport [data-region="tab"]').nth(index).locator(".tab-icon, .tab-icon-special").first().boundingBox())!;
      return icon.x - box.x;
    };
    const before = await iconOffset(0);
    // Open tabs until the inactive tabs turn icon-only.
    for (let i = 0; i < 12 && !(await page.locator(".tab.compact").count()); i++) {
      await pressShortcut(page, "t", { ctrlKey: true });
      await page.waitForTimeout(250);
    }
    await expect(page.locator(".tab.compact").first()).toBeVisible();
    const after = await iconOffset(0);
    expect(Math.abs(after - before), `icon offset ${before} -> ${after}`).toBeLessThanOrEqual(1);
  });

  /** Box of a shown island region, in page CSS px. */
  async function islandBox(page: Page, region: string) {
    return (await page.locator(`[data-region="${region}"]:visible`).first().boundingBox())!;
  }

  /** The active tab's hole (`data-tab-hole`), in page CSS px (the title bar starts at the page's left edge). */
  async function holeBox(page: Page): Promise<{ left: number; right: number } | null> {
    const hole = await page.locator('[data-region="titlebar"]').getAttribute("data-tab-hole");
    if (!hole) return null;
    const [left, right] = hole.split(" ").map(Number);
    return { left, right };
  }

  // Tabs run over the sidebar (#1785). On Windows and Linux the strip starts
  // just past the surface's rounded top-left corner plus the tab's foot, so
  // even the first tab shows its whole left curve beside a whole corner.
  for (const theme of ["light", "dark"]) test(`tabs run over the sidebar, the first tab's curve whole past the surface's corner (${theme})`, async ({ page }) => {
    await openIslands(page, { theme, active: 0 });
    await page.mouse.move(5, 500);
    const tab = await activeTabBox(page);
    const sidebar = await islandBox(page, "sidebar");
    expect(tab.x, "the first tab stands over the sidebar").toBeGreaterThan(sidebar.x);
    expect(tab.x, "the first tab stands over the sidebar").toBeLessThan(sidebar.x + sidebar.width);
    const foot = tab.x - 14;
    expect(foot, "the left fillet's foot lies past the surface's 14px corner").toBeGreaterThanOrEqual(14);
    expect(Math.abs((await holeBox(page))!.left - foot), "the hole opens from the foot").toBeLessThanOrEqual(0.6);
    // In pixels, with the islands hidden: inside the fillet's curve the hole
    // shows the surface; on its outer side, the strip shade; and the corner
    // below keeps its whole radius (its pocket is shade, inside its arc the
    // surface).
    const base = Math.round(tab.y + tab.height);
    const one = async (x: number, y: number) => (await pixels(page, { x, y, width: 1, height: 1 }))[0];
    const at = await withIslandsHidden(page, async () => ({
      body: await one(Math.round(tab.x + tab.width / 2), base - 3),
      strip: await one(8, Math.round(tab.y) + 2),
      inFillet: await one(Math.round(tab.x) - 2, base - 2),
      outsideFillet: await one(Math.round(tab.x) - 10, base - 10),
      pocket: await one(2, base + 2),
      corner: await one(6, base + 6),
    }));
    expect(distance(at.inFillet, at.body), "inside the fillet: the surface").toBeLessThanOrEqual(8);
    expect(distance(at.outsideFillet, at.strip), "beside the fillet: the strip").toBeLessThanOrEqual(6);
    expect(distance(at.pocket, at.strip), "outside the corner: the strip").toBeLessThanOrEqual(6);
    expect(distance(at.corner, at.body), "inside the corner: the surface").toBeLessThanOrEqual(8);
    expect(distance(at.body, at.strip), "the fixture tells surface from strip").toBeGreaterThanOrEqual(12);
  });

  /** Shown islands (each draws its own outline), in page CSS px with their computed outline styles. */
  async function shownIslands(page: Page) {
    return page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
      '[data-region="sidebar"], [data-region="panes"]:not([data-split]), [data-region="panes"][data-split] [data-region="pane"], [data-region="preview"], [data-region="miller-island"]',
    )].filter((el) => !el.closest(".retained") && el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions)).map((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        region: `${el.dataset.region}${el.closest("[data-split]") ? " (split)" : ""}`,
        left: r.left, right: r.right, top: r.top,
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
        clipPath: style.clipPath,
        shadow: style.boxShadow,
      };
    }));
  }

  /** Two adjacent columns as one split tab (row split), for every tab. */
  async function splitEveryTab(page: Page, active: number) {
    await page.evaluate(async (active) => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const manager = (await load()).windowTabsManager;
      const leaf = (id: string, path: string) => ({ type: "leaf", id, path });
      manager.restoreFromState({ version: 3, activeTabId: `s-${active}`, tabs: [0, 1, 2].map((i) => ({
        id: `s-${i}`, kind: "explorer", activePaneId: `l-${i}`,
        layout: { type: "split", id: `split-${i}`, direction: "row", ratio: 0.5, first: leaf(`l-${i}`, "/home/user"), second: leaf(`r-${i}`, "/home/user/Documents") },
      })) });
    }, active);
    await expect(page.locator(".pane-tree:not(.retained) .explorer-pane")).toHaveCount(2);
  }

  // Every island keeps its own outline wherever the active tab stands
  // (#1785): its rounded corners, top edge and shadow, 8px below the strip
  // base. The tab never opens an island's edge or squares its corners, even
  // with its foot over the gutter between two islands.
  const STANCES = [
    { what: "the sidebar's gutter", count: 3, active: 1, split: false, islands: 2, settings: {} },
    { what: "split panes' gutter", count: 3, active: 2, split: true, islands: 3, settings: {} },
    { what: "the preview's gutter", count: 3, active: 2, split: false, islands: 3, settings: { showPreviewPane: true, previewPaneWidth: 500 } },
  ] as const;
  for (const stance of STANCES) for (const theme of ["light", "dark"]) test(`islands keep their own top edges and corners with the tab over ${stance.what} (${theme})`, async ({ page }) => {
    await openIslands(page, { theme, count: stance.count, active: stance.active, settings: stance.settings });
    if (stance.split) await splitEveryTab(page, stance.active);
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    const tab = await activeTabBox(page);
    const base = tab.y + tab.height;
    const hole = (await holeBox(page))!;
    const islands = await shownIslands(page);
    expect(islands.length, JSON.stringify(islands)).toBeGreaterThanOrEqual(stance.islands);
    // The fixture: the tab's hole reaches over a gutter, across one island's
    // top-right corner and the next one's top-left corner.
    const sorted = [...islands].sort((a, b) => a.left - b.left);
    const straddled = sorted.findIndex((island, i) => i + 1 < sorted.length && hole.left < island.right - 4 && hole.right > sorted[i + 1].left + 4);
    expect(straddled, `the hole ${JSON.stringify(hole)} straddles a gutter of ${JSON.stringify(sorted.map(({ left, right }) => [left, right]))}`).toBeGreaterThanOrEqual(0);
    for (const island of islands) {
      expect(island.top - base, `${island.region} sits 8px below the base`).toBeCloseTo(8, 0);
      expect(island.radii, `${island.region} corners`).toEqual(["14px", "14px", "14px", "14px"]);
      expect(island.clipPath, `${island.region} is not clipped`).toBe("none");
      expect(island.shadow, `${island.region} casts its shadow`).not.toBe("none");
    }
    // In pixels: the islands' top edges and corners under the hole read
    // exactly as they do with the tab's layers (hole, shade, outline,
    // shadows) hidden, so nothing the tab draws reaches an island.
    const clip = { x: Math.round(hole.left) - 4, y: Math.round(base) + 4, width: Math.round(hole.right - hole.left) + 8, height: 24 };
    const actual = await pixels(page, clip);
    const tag = await page.addStyleTag({ content: '[data-region="tab-edge"], [data-region="tab-key-shadow"] { visibility: hidden !important; }' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const reference = await pixels(page, clip);
    await tag.evaluate((el) => el.remove());
    const worst = Math.max(...actual.map((pixel, i) => distance(pixel, reference[i])));
    // Up to 4: any restyle (even a no-op one) re-rasterises the islands'
    // anti-aliased corner arcs by that much, as in tab-outline-matrix.ts.
    expect(worst, "the islands' edges under the tab vs drawn alone").toBeLessThanOrEqual(4);
  });

  // ---- Narrow windows (#1744 review 2) ----

  /** The active tab, the tab scroller, the hole and the outline, in page CSS px. */
  async function stripState(page: Page) {
    return page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-region="titlebar"]')!;
      const zoom = parseFloat(document.documentElement.style.zoom) / 100 || 1;
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left / zoom, right: r.right / zoom, top: r.top / zoom, bottom: r.bottom / zoom };
      };
      const hole = bar.getAttribute("data-tab-hole")?.split(" ").map(Number) ?? null;
      const barBox = bar.getBoundingClientRect();
      const barLeft = barBox.left / zoom;
      const tab = box(bar.querySelector('.tab-viewport [data-region="tab"][aria-selected="true"]'));
      // The outline (title bar user space): whether it rises above the
      // strip base anywhere (over a shown tab), and whether it runs along
      // the active tab's top edge.
      const stroke = bar.querySelector<SVGGeometryElement>(".tab-edge-stroke");
      const strokeBox = stroke?.getAttribute("d") ? stroke.getBBox() : null;
      const base = barBox.height / zoom;
      return {
        tab,
        view: box(bar.querySelector(".tab-viewport")),
        hole: hole && { left: hole[0] + barLeft, right: hole[1] + barLeft },
        rises: Boolean(strokeBox && strokeBox.y < base - 2),
        overTab: Boolean(tab && stroke?.isPointInStroke({ x: (tab.left + tab.right) / 2 - barLeft, y: tab.top - barBox.top / zoom + 0.5 })),
        overflowing: Boolean(bar.querySelector(".tab-viewport:not(.bleed)")),
        compact: bar.querySelectorAll(".tab.compact").length,
        buttons: bar.querySelectorAll(".tab-scroll-btn").length,
        start: parseFloat(getComputedStyle(bar.querySelector('[data-region="tab-strip"]')!).getPropertyValue("--tab-strip-start")),
      };
    });
  }

  for (const width of [560, 640]) test(`a narrow window shows its active tab at load and draws the outline only over it (${width}px)`, async ({ page }) => {
    await openIslands(page, { width, count: 14 });
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);
    const state = await stripState(page);
    expect(state.overflowing, "the fixture overflows").toBe(true);
    // The active (last) tab is wholly inside the scroller...
    expect(state.tab!.left).toBeGreaterThanOrEqual(state.view!.left - 0.5);
    expect(state.tab!.right).toBeLessThanOrEqual(state.view!.right + 0.5);
    // ...and the hole and the outline open over it, nowhere else.
    expect(Math.abs(state.hole!.left - (state.tab!.left - 14))).toBeLessThanOrEqual(1);
    expect(Math.abs(state.hole!.right - (state.tab!.right + 14))).toBeLessThanOrEqual(1);
    expect(state.overTab, "the outline runs over the active tab").toBe(true);
    // An overflowing strip, however narrow, offers its scroll buttons.
    expect(state.buttons).toBe(2);
    // Scrolled out of view (past the faded end under the scroll button), the
    // active tab leaves no hole and the surface's top edge runs straight.
    await page.locator(".tab-viewport").evaluate((el) => { el.scrollLeft = 0; });
    await expect.poll(async () => (await stripState(page)).rises).toBe(false);
    expect((await stripState(page)).hole).toBeNull();
    // Scrolled back, the outline rises over the tab again.
    await page.locator(".tab-viewport").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(async () => (await stripState(page)).overTab).toBe(true);
  });

  // A narrow window gives the band before the first tab back to its tabs
  // (`tabStripStart`): the first tab's foot then reaches into the surface's
  // top-left corner, which narrows to end where the foot begins (#1785).
  for (const theme of ["light", "dark"]) test(`a narrow window gives the band before the first tab back to its tabs (${theme})`, async ({ page }) => {
    await openIslands(page, { theme, width: 560, count: 4, active: 0 });
    await page.mouse.move(5, 500);
    const state = await stripState(page);
    expect(state.overflowing).toBe(false);
    expect(state.compact, "no icon-only tabs").toBe(0);
    // Each inactive title has a readable box, wider than its 16px fade.
    const titles = await page.locator('.tab-viewport [data-region="tab"]:not([aria-selected="true"]) .tab-title').evaluateAll((els) => els.map((el) => el.clientWidth));
    expect(titles.length).toBe(3);
    for (const width of titles) expect(width).toBeGreaterThanOrEqual(24);
    // The strip starts before the 30px that clears the corner, to make that room.
    const tab = await activeTabBox(page);
    expect(state.start).toBeLessThan(30);
    expect(tab.x - 14, "the foot reaches into the corner").toBeLessThan(14);
    // The corner gives way: where a whole corner's pocket of strip shade
    // would be (3px in from the window edge and 3px below the base), the
    // surface shows, one with the tab's.
    const base = Math.round(tab.y + tab.height);
    const one = async (x: number, y: number) => (await pixels(page, { x, y, width: 1, height: 1 }))[0];
    const at = await withIslandsHidden(page, async () => ({
      body: await one(Math.round(tab.x + tab.width / 2), base - 3),
      strip: await one(8, Math.round(tab.y) + 2),
      corner: await one(3, base + 3),
    }));
    expect(distance(at.corner, at.body), "the narrowed corner shows the surface").toBeLessThanOrEqual(8);
    expect(distance(at.corner, at.strip), "not the strip shade").toBeGreaterThanOrEqual(12);
  });
  // The strip start follows the islands and the room it measures, and writing
  // it resizes the strip. Neither measurement may observe a box that write
  // resizes in the same frame: WebKit reports that as a ResizeObserver loop
  // (a dense split layout restored at 130% did, and so did resizing a
  // window whose start was giving the sidebar band back to its tabs).
  test("aligning the strip never loops its ResizeObservers", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 640, height: 480 });
    await seedSettings(page, { layoutTheme: "floating-islands", zoomLevel: 130 });
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
    await page.waitForTimeout(500);
    const ids = Array.from({ length: 16 }, (_, i) => i);
    type Node = { type: "leaf"; id: string; path: string } | { type: "split"; id: string; direction: "row" | "column"; ratio: number; first: Node; second: Node };
    const split = (part: number[], depth = 0): Node => {
      if (part.length === 1) return { type: "leaf", id: `dense-${part[0]}`, path: "/home/user/Documents" };
      const middle = Math.ceil(part.length / 2);
      return { type: "split", id: `dense-split-${part.join("-")}`, direction: depth % 2 ? "column" : "row", ratio: 0.5, first: split(part.slice(0, middle), depth + 1), second: split(part.slice(middle), depth + 1) };
    };
    await page.evaluate(async (layout) => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      (await load()).windowTabsManager.restoreFromState({ version: 3, tabs: [{ id: "dense", kind: "explorer", activePaneId: "dense-15", layout }], activeTabId: "dense" });
    }, split(ids));
    await expect(page.locator(".explorer-pane")).toHaveCount(16);
    await page.waitForTimeout(300);
    // Resizing moves the start through the range where it gives the band
    // over the sidebar back to the tabs.
    for (const width of [700, 760, 820, 900, 1100, 760, 640]) {
      await page.setViewportSize({ width, height: 480 });
      await page.waitForTimeout(150);
    }
    expect(errors).toEqual([]);
  });

  test("the empty band before the first tab drags the window", async ({ page }) => {
    await openIslands(page);
    await page.mouse.move(5, 500);
    const strip = (await page.locator('[data-region="tab-strip"]').boundingBox())!;
    const first = (await page.locator('.tab-viewport [data-region="tab"]').first().boundingBox())!;
    // The band clears the surface's corner and the first tab's foot (#1785).
    expect(first.x - strip.x, "the fixture has a band").toBeGreaterThanOrEqual(28);
    const drags = (x: number, y: number) => page.evaluate(async ({ x, y }) => {
      const load = new Function("return import('/src/lib/domain/titlebar.ts')");
      const { startsWindowDrag } = await load();
      const target = document.elementFromPoint(x, y);
      return Boolean(target?.closest('[data-region="titlebar"]')) && startsWindowDrag(target);
    }, { x, y });
    const y = first.y + first.height / 2;
    expect(await drags(strip.x + 4, y), "the band").toBe(true);
    expect(await drags(first.x - 18, y), "just before the first tab's foot").toBe(true);
    expect(await drags(first.x + first.width / 2, y), "a tab").toBe(false);
  });

  // Crossing into overflow scrolls the strip to show the new tab: the tabs
  // glide there with the slide, never jumping in one frame, and the new tab
  // is never cut by the scroller's edge.
  test("a narrow strip crossing into overflow glides, its new tab whole", async ({ page }) => {
    await openIslands(page, { width: 560, count: 7 });
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    expect(frames.some((frame) => frame.overflowing), "the fixture crosses into overflow").toBe(true);
    const total = Math.abs(frames[frames.length - 1].firstLeft! - frames[0].firstLeft!);
    for (let index = 1; index < frames.length; index++) {
      const step = Math.abs(frames[index].firstLeft! - frames[index - 1].firstLeft!);
      expect(step, `first tab t=${frames[index].t} of ${total.toFixed(1)}`).toBeLessThanOrEqual(Math.max(1, total * 0.5));
    }
    for (const frame of frames.slice(1)) {
      expect(frame.active!.right, `t=${frame.t}`).toBeLessThanOrEqual(frame.view![1] + 0.5);
      expect(frame.hole![1], `hole t=${frame.t}`).toBeLessThanOrEqual(frame.view![1] + 0.5);
    }
  });

  // A strip that fills its room, fitting or overflowing: the tab sliding in
  // grows as the others shrink, so their total (and the new-tab button
  // behind them) holds still, and an overflowing strip keeps its end in
  // place while its start glides away. At 1100px with ten tabs the button
  // dipped mid-slide; overflowing, the strip scrolled its end away.
  for (const [width, count] of [[1100, 10], [560, 6], [1100, 16]] as const) test(`a full strip holds its new-tab button still while a tab slides in (${width}px, ${count} tabs)`, async ({ page }) => {
    await openIslands(page, { width, count, theme: "light" });
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    expect(frames.some((frame) => frame.widths.length === count + 1), "the fixture opens a tab").toBe(true);
    const steady = frames[0].plusLeft!;
    expect(Math.abs(frames[frames.length - 1].plusLeft! - steady), "the fixture fills its room").toBeLessThanOrEqual(1);
    for (const frame of frames) {
      expect(Math.abs(frame.plusLeft! - steady), `+ at t=${frame.t}`).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.lastRight! - frames[0].lastRight!), `last tab's end at t=${frame.t}`).toBeLessThanOrEqual(1);
    }
  });

  // Inactive tabs either show a title box wider than its fade, or no title.
  for (const count of [3, 6, 9]) test(`inactive tabs show no fragments of titles (${count} tabs)`, async ({ page }) => {
    await openIslands(page, { count, theme: "light" });
    await page.mouse.move(5, 500);
    for (let width = 520; width <= 940; width += 30) {
      await page.setViewportSize({ width, height: 600 });
      await expect.poll(() => page.locator('.tab-viewport [data-region="tab"]:not([aria-selected="true"]) .tab-title').evaluateAll((els) =>
        els.map((el) => (getComputedStyle(el).display === "none" ? null : el.clientWidth)).filter((box) => box !== null && box < 24)), `${width}px`).toEqual([]);
    }
  });

  // A sliding tab's title box passes through widths narrower than its 16px
  // fade: there a lone glyph stem painted, like a caret (#1744 review). On
  // every stepped frame, a title box under 24px paints no ink; the oracle
  // compares the frame with that title hidden.
  for (const { what, width, count } of [
    { what: "opening, 3 tabs at 1100px", width: 1100, count: 3 },
    { what: "opening, 5 tabs at 560px", width: 560, count: 5 },
    { what: "closing, 3 tabs at 1100px", width: 1100, count: 3 },
  ]) test(`a sliding tab never paints a fragment of its title (${what})`, async ({ page }) => {
    // Every step takes four screenshots and several frames; a CI WebKit
    // runner needed 26s of the default 30s for the opening case.
    test.setTimeout(90_000);
    const closing = what.startsWith("closing");
    await openIslands(page, { theme: "light", count, width, active: count - 1 });
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    // Opening: the new active tab grows. Closing: the closed tab shrinks
    // out, inert, while its neighbour takes over.
    const sliding = closing ? '.tab-viewport [data-region="tab"][inert]' : '.tab-viewport [data-region="tab"][aria-selected="true"]';
    const samples: { step: number; box: number; ink: number }[] = [];
    const shot = async (clip: { x: number; y: number; width: number; height: number }) => {
      const png = await page.screenshot({ clip });
      return page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return [...context.getImageData(0, 0, image.width, image.height).data];
      }, png.toString("base64"));
    };
    await steppedFrames(page, () => closing
      ? pressShortcut(page, "w", { ctrlKey: true, shiftKey: true })
      : pressShortcut(page, "t", { ctrlKey: true }), {
      // Through the slide's end: 120ms closing, 180ms opening.
      steps: closing ? 9 : 13,
      onStep: async (step) => {
        const title = page.locator(`${sliding} .tab-title`);
        if (await title.count() !== 1) return;
        const measure = () => title.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height, client: el.clientWidth };
        });
        const diff = (a: number[], b: number[]) => {
          let most = 0;
          for (let i = 0; i < a.length; i += 4) {
            most = Math.max(most, Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          }
          return most;
        };
        // steppedFrames pauses the title bar's animations while a step is
        // inspected, so the frame holds still across its screenshots: the
        // title's box and its shown frame are the same before and after the
        // frame without it. The title is painted afresh first: the first
        // frame of a closing tab could keep a raster of its title whose
        // antialiasing differs (by up to 56/255) from the one any repaint
        // gives, which the hidden-title frame forces.
        const box = await measure();
        if (box.width < 0.5) return;
        const clip = { x: Math.floor(box.x) - 1, y: Math.floor(box.y), width: Math.ceil(box.width) + 2, height: Math.ceil(box.height) };
        await title.evaluate(async (el) => {
          el.style.visibility = "hidden";
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          el.style.visibility = "";
        });
        const shown = await shot(clip);
        await title.evaluate((el) => { el.style.visibility = "hidden"; });
        const hidden = await shot(clip);
        await title.evaluate((el) => { el.style.visibility = ""; });
        const again = await shot(clip);
        expect(await measure(), `step ${step}: the title's box holds still`).toEqual(box);
        expect(diff(shown, again), `step ${step}: the held frame holds still`).toBe(0);
        const ink = diff(shown, hidden);
        samples.push({ step, box: box.client, ink });
      },
    });
    const narrow = samples.filter((sample) => sample.box < 24);
    expect(narrow.length, `frames with a title box under 24px: ${JSON.stringify(samples)}`).toBeGreaterThan(0);
    for (const sample of narrow) expect(sample.ink, `step ${sample.step}, title box ${sample.box}px`).toBeLessThanOrEqual(2);
    // The oracle sees a title once there is room for one.
    expect(Math.max(...samples.filter((sample) => sample.box >= 40).map((sample) => sample.ink), 0), "a wider title paints").toBeGreaterThan(40);
  });

  test("a title that fits is not faded, one that does not is", async ({ page }) => {
    // Four tabs: since the strip runs over the sidebar (#1785), three are at
    // their widest, where WebKit at 125% measures every title box 1px wider
    // than itself (151/150), so none counts as fitting.
    await openIslands(page, { theme: "light", count: 4, active: 2, settings: { zoomLevel: 125 } });
    await page.mouse.move(5, 500);
    const titles = await page.locator('.tab-viewport [data-region="tab"] .tab-title').evaluateAll((els) => els.map((el) => {
      const fits = [el, ...el.children].every((part) => part.scrollWidth <= part.clientWidth);
      const style = getComputedStyle(el);
      return { fits, masked: (style.maskImage || style.webkitMaskImage || "none") !== "none" };
    }));
    expect(titles.some((title) => title.fits), "the fixture has a title that fits").toBe(true);
    for (const title of titles) expect(title.masked).toBe(!title.fits);
    await page.setViewportSize({ width: 640, height: 600 });
    await expect.poll(() => page.locator('.tab-viewport [data-region="tab"][aria-selected="true"] .tab-title').evaluate((el) => {
      const style = getComputedStyle(el);
      return (style.maskImage || style.webkitMaskImage || "none") !== "none" && el.querySelector(".tab-cwd")!.scrollWidth > el.querySelector(".tab-cwd")!.clientWidth;
    })).toBe(true);
  });

  for (const side of ["before", "after"] as const) test(`a hovered neighbour's pill keeps clear of the active tab's fillet (${side})`, async ({ page }) => {
    await openIslands(page, { count: 3, active: 1 });
    const tabs = page.locator('.tab-viewport [data-region="tab"]');
    const neighbour = tabs.nth(side === "before" ? 0 : 2);
    await neighbour.hover();
    const gap = await neighbour.evaluate((el, side) => {
      const active = document.querySelector('.tab-viewport [data-region="tab"][aria-selected="true"]')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const pill = getComputedStyle(el, "::before");
      return side === "before" ? active.left - (box.right - parseFloat(pill.right)) : (box.left + parseFloat(pill.left)) - active.right;
    }, side);
    // The fillet reaches about 5px out at the pill's lower corner.
    expect(gap).toBeGreaterThanOrEqual(8);
  });
});
