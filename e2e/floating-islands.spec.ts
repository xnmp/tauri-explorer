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
import { framesOfNewTab, type TabFrame } from "./tab-frames";

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
 * #1734: under Floating Islands the active tab owns the window. It wears the
 * surface of the island it stands on and opens into that island's top edge;
 * the rest of the strip is shaded. Inline SVG marks follow the tab every
 * frame of a slide.
 */
test.describe("Fused active tab (#1734)", () => {
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

  async function openIslands(page: Page, { theme = "dark", material = false, count = 3 } = {}): Promise<void> {
    await page.setViewportSize({ width: 1100, height: 600 });
    if (material) {
      await page.addInitScript(() => {
        Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel", configurable: true });
      });
    }
    await seedSettings(page, {
      layoutTheme: "floating-islands",
      theme,
      showWindowControls: true,
      tabTitleGitRoot: false,
      ...(material ? { macOsVibrancy: true, vibrancyBlur: true } : {}),
    });
    // The last tab is active: with three it stands over the panes island.
    await page.addInitScript(({ paths, count }) => {
      localStorage.setItem("explorer-tabs", JSON.stringify({
        version: 3,
        tabs: Array.from({ length: count }, (_, i) => ({ id: `fused-${i}`, kind: "explorer", activePaneId: `fused-pane-${i}`, layout: { type: "leaf", id: `fused-pane-${i}`, path: paths[i % paths.length] } })),
        activeTabId: `fused-${count - 1}`,
      }));
    }, { paths: PATHS, count });
    await page.goto("/");
    await waitForEntries(page);
    if (material) {
      await expect(page.locator("html")).toHaveAttribute("data-macos-material", "");
      await page.addStyleTag({ content: SIMULATED_MATERIAL });
    }
    await expect(page.locator('[data-region="titlebar"]')).toHaveAttribute("data-tab-island", "content");
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
      test(`the tab wears its island's surface, with no seam or sliver (${theme}, ${material ? "macOS material" : "opaque"})`, async ({ page }) => {
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

        // Tab and island are one surface across the seam.
        const center = Math.round(tab.x + tab.width / 2);
        const [above] = await pixels(page, { x: center, y: base - 3, width: 1, height: 1 });
        const [below] = await pixels(page, { x: center, y: base + 3, width: 1, height: 1 });
        expect(distance(above, below)).toBeLessThanOrEqual(10);

        // The rest of the strip is shaded: darker than the tab.
        const [strip] = await pixels(page, { x: 8, y: Math.round(tab.y) + 2, width: 1, height: 1 });
        expect(luminance(strip)).toBeLessThan(luminance(above) - 1);

        if (material) {
          await page.screenshot({ path: `screenshots/feat/islands-tab-owns-window/islands-${theme}.png`, animations: "disabled" });
        }
      });
    }
  }

  /** Frames of a Ctrl+T slide, from the first that shows the new tab. */
  async function slideFrames(page: Page): Promise<TabFrame[]> {
    await page.waitForTimeout(300);
    const frames = await framesOfNewTab(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    expect(frames.length).toBeGreaterThanOrEqual(4);
    return frames;
  }

  test("the seam and edge highlight follow a sliding tab frame by frame", async ({ page }) => {
    await openIslands(page);
    for (const frame of await slideFrames(page)) {
      const { active, hole, fill, edge } = frame;
      expect(active, `t=${frame.t}`).not.toBeNull();
      const expected = [active!.left - active!.fillet, active!.right + active!.fillet];
      expect(hole, `hole t=${frame.t}`).not.toBeNull();
      expect(Math.abs(hole![0] - expected[0]), `hole left t=${frame.t}`).toBeLessThanOrEqual(0.6);
      expect(Math.abs(hole![1] - expected[1]), `hole right t=${frame.t}`).toBeLessThanOrEqual(0.6);
      // A tab with no width yet has nothing to fill or outline.
      if (active!.width < 1) continue;
      expect(fill, `fill t=${frame.t}`).not.toBeNull();
      expect(Math.abs(fill![0] - expected[0]), `fill left t=${frame.t}`).toBeLessThanOrEqual(1);
      expect(Math.abs(fill![1] - expected[1]), `fill right t=${frame.t}`).toBeLessThanOrEqual(1);
      expect(edge, `edge t=${frame.t}`).not.toBeNull();
      expect(edge![0], `edge left t=${frame.t}`).toBeLessThanOrEqual(expected[0] + 0.5);
      expect(edge![1], `edge right t=${frame.t}`).toBeGreaterThanOrEqual(expected[1] - 0.5);
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

  test("a sliding tab keeps its fillets, in proportion to its width", async ({ page }) => {
    await openIslands(page);
    const frames = await slideFrames(page);
    const final = frames[frames.length - 1].active!;
    expect(final.fillet).toBeCloseTo(14, 0);
    for (const { t, active } of frames) {
      expect(Math.abs(active!.fillet - (14 * active!.width) / final.width), `t=${t}`).toBeLessThanOrEqual(1);
    }
  });

  for (const count of [3, 8]) test(`first frames: the new tab grows from nothing while the others hold still (${count} tabs)`, async ({ page }) => {
    // Eight tabs compress: the strip must size every tab for the new count
    // in the frame the new tab appears, not one frame later.
    await openIslands(page, { count });
    const frames = await slideFrames(page);
    const final = frames[frames.length - 1];
    const finalWidth = final.active!.width;
    expect(frames[0].active!.width).toBeLessThanOrEqual(finalWidth * 0.35);
    let previous = 0;
    for (const frame of frames) {
      const width = frame.active!.width;
      expect(width, `t=${frame.t}`).toBeGreaterThanOrEqual(previous - 0.5);
      expect(width - previous, `t=${frame.t}`).toBeLessThanOrEqual(finalWidth * 0.5);
      previous = width;
      // Every other tab keeps its final width in every frame (no one-frame
      // squeeze while the strip remeasures).
      frame.widths.forEach((other, i) => {
        if (i !== frame.activeIndex) expect(Math.abs(other - final.widths[i]), `tab ${i} t=${frame.t}`).toBeLessThanOrEqual(0.5);
      });
    }
    expect(Math.abs(previous - finalWidth)).toBeLessThanOrEqual(0.5);
  });
});
