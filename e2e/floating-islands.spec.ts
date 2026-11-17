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
import { expectSeededGrowth, steppedFrames, steppedFramesOfNewTab, type TabFrame } from "./tab-frames";

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

        // The rest of the strip is shaded, clearly darker than the tab, so the
        // tab reads as part of its island. Opaque: a luminance step of at
        // least 12 (of 255; the default dark theme measures ~15, light ~45,
        // Chrome's dark frame ~20). Over the material the shade is
        // translucent and the wallpaper varies, so the floor is 8 (measured
        // ~11 light, ~17 dark over the simulated wallpaper).
        const [strip] = await pixels(page, { x: 8, y: Math.round(tab.y) + 2, width: 1, height: 1 });
        expect(luminance(above) - luminance(strip)).toBeGreaterThanOrEqual(material ? 8 : 12);

        if (material) {
          await page.screenshot({ path: `screenshots/feat/islands-tab-owns-window/islands-${theme}.png`, animations: "disabled" });
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

  test("the seam and edge highlight follow a sliding tab frame by frame", async ({ page }) => {
    await openIslands(page);
    for (const frame of await slideFrames(page)) {
      const { active, hole, fill, edge } = frame;
      expect(active, `t=${frame.t}`).not.toBeNull();
      const expected = [active!.left - active!.fillet, active!.right + active!.fillet];
      expect(hole, `hole t=${frame.t}`).not.toBeNull();
      expect(Math.abs(hole![0] - expected[0]), `hole left t=${frame.t}`).toBeLessThanOrEqual(0.6);
      expect(Math.abs(hole![1] - expected[1]), `hole right t=${frame.t}`).toBeLessThanOrEqual(0.6);
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
    // must not overflow and scroll every tab sideways.
    for (const frame of all) expect(Math.abs(frame.firstLeft! - all[0].firstLeft!), `first tab t=${frame.t}`).toBeLessThanOrEqual(0.5);
    // The existing tabs (indices below `count`) ease to their new width:
    // no 15ms step, including the one the new tab appears in, covers more
    // than half of a tab's whole change (a snap covers all of it).
    for (let i = 0; i < count; i++) {
      const change = Math.abs(all[all.length - 1].widths[i] - all[0].widths[i]);
      for (let index = 1; index < all.length; index++) {
        const step = Math.abs(all[index].widths[i] - all[index - 1].widths[i]);
        expect(step, `tab ${i} t=${all[index].t} of ${change.toFixed(1)}`).toBeLessThanOrEqual(Math.max(1, change * 0.5));
      }
    }
  });

  /**
   * Exactly one tab reads as the active one on every frame, from the frame
   * before the action on: it is selected, wide enough to show its icon, and
   * fused to its island (the hole, fill, full-strength outline and open
   * island edge all sit on it). A frame where no tab, or two, own the island
   * fails, as does a frame where the owner is an empty sliver.
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
      expect(frame.fill, `fill ${at}`).not.toBeNull();
      expect(Math.abs(frame.fill![0] - expected[0]), `fill left ${at}`).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.fill![1] - expected[1]), `fill right ${at}`).toBeLessThanOrEqual(1);
      expect(frame.edgeOpacity, `edge ${at}`).toBeGreaterThanOrEqual(0.99);
      expect(frame.seamed, `seam ${at}`).toBeGreaterThanOrEqual(1);
    }
  }

  for (const count of [3, 8]) test(`opening a tab: the new tab owns the island from its first frame (${count} tabs)`, async ({ page }) => {
    await openIslands(page, { count });
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "t", { ctrlKey: true }));
    await expect(page.locator('.tab-viewport [data-region="tab"]')).toHaveCount(count + 1);
    expectOneActiveTab(frames);
    // The new (last) tab is the active one from the first frame after Ctrl+T.
    for (const frame of frames.slice(1)) expect(frame.activeIndex, `t=${frame.t}`).toBe(count);
  });

  test("closing the active tab hands the seam to its neighbour in the same frame", async ({ page }) => {
    await openIslands(page);
    await page.waitForTimeout(300);
    const frames = await steppedFrames(page, () => pressShortcut(page, "w", { ctrlKey: true, shiftKey: true }));
    await expect(page.locator('.tab-viewport [data-region="tab"]')).toHaveCount(2);
    expectOneActiveTab(frames);
  });

  test("switching tabs by click and Ctrl+Tab moves the seam in the same frame", async ({ page }) => {
    await openIslands(page);
    await page.waitForTimeout(300);
    const first = page.locator('.tab-viewport [data-region="tab"]').first();
    expectOneActiveTab(await steppedFrames(page, () => first.click(), { steps: 8 }));
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.mouse.move(5, 400);
    expectOneActiveTab(await steppedFrames(page, () => pressShortcut(page, "Tab", { ctrlKey: true }), { steps: 8 }));
    await expect(page.locator('.tab-viewport [data-region="tab"]').nth(1)).toHaveAttribute("aria-selected", "true");
  });
});
