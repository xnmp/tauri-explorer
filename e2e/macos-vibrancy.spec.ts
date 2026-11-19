/**
 * E2E test: macOS vibrancy setting.
 * Issue: feat/macos-vibrancy, #1306 (native backdrop is independent of layout)
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, applySettingsAndReload, waitForEntries } from "./helpers";
import { decodePng } from "./png-pixels";

test.describe("macOS vibrancy", () => {
  // The browser publishes no native material, so the platform fallback decides:
  // macOS gets vibrancy.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel", configurable: true });
    });
  });

  test("data-native-backdrop is set when translucency is enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { translucency: true });
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-native-backdrop", "");
  });

  test("data-native-backdrop is absent when translucency is disabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { translucency: false });
    await waitForEntries(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-native-backdrop");
  });

  test("vibrancy CSS makes body transparent when enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { translucency: true });
    await waitForEntries(page);

    const bodyBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );
    expect(bodyBg).toBe("rgba(0, 0, 0, 0)");
  });

  test("native backdrop works under every layout, including Default", async ({ page }) => {
    await page.goto(HOME_URL);
    for (const layoutTheme of ["default", "floating-islands", "hairline-ledger", "compact", "soft-cards"]) {
      await applySettingsAndReload(page, { translucency: true, layoutTheme });
      await waitForEntries(page);
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-layout", layoutTheme);
      await expect(html).toHaveAttribute("data-native-backdrop", "");
      // Transparency is the window's, not the layout's: the body stays clear.
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    }
  });
});

/**
 * #1733, #1789: under the macOS material the theme's own colours cover most
 * of the material, so the palette survives it. Default and Compact fade the
 * opaque window uniformly; Floating Islands tints its window body and stacks
 * islands on it. The browser cannot show the native material, so the window
 * "behind" is an html background.
 */
test.describe("theme colours over the macOS material (#1733, #1789)", () => {
  async function openVibrant(page: Page, theme: string, platform = "MacIntel", layoutTheme = "default", extra: Record<string, unknown> = {}): Promise<void> {
    await page.addInitScript((value) => {
      Object.defineProperty(window.navigator, "platform", { get: () => value, configurable: true });
    }, platform);
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, {
      translucency: true,
      layoutTheme,
      theme,
      ...extra,
    });
    await waitForEntries(page);
  }

  /** The window body's paint, and what the given share of `color` (the theme
   *  base by default) computes to in the same document (same serialization). */
  async function tint(page: Page, color = "var(--background-solid)") {
    return page.evaluate((source) => {
      const mix = (share: number) => {
        const probe = document.createElement("div");
        probe.style.background = `color-mix(in srgb, ${source} ${share}%, transparent)`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      };
      return {
        body: getComputedStyle(document.querySelector(".explorer")!).backgroundColor,
        light: mix(15),
        dark: mix(55),
        islandsDark: mix(30),
        full: mix(100),
      };
    }, color);
  }

  /**
   * #1789: Default and Compact fade the opaque window uniformly. Each surface
   * is screenshotted over a black and a white backdrop: over black it shows
   * colour x alpha, over white that plus (1 - alpha) x 255, which gives the
   * share of the material it hides (alpha) and its colour. Every surface must
   * hide the same share and keep its opaque colour: the tab, title bar,
   * navigation bar and column header are the pane's colour, the sidebar its own.
   */
  type Rgb = [number, number, number];
  const REGIONS = {
    tab: '[data-region="tab"][aria-selected="true"]',
    titlebar: '[data-region="titlebar"]',
    navbar: '[data-region="toolbar"]',
    header: ".column-headers",
    pane: '[data-region="pane"]',
    sidebar: '[data-region="sidebar-body"]',
  } as const;
  type Region = keyof typeof REGIONS;

  /** A point inside each region away from text and icons. */
  async function probePoints(page: Page): Promise<Record<Region, { x: number; y: number }>> {
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const tab = await box(REGIONS.tab);
    const titlebar = await box(REGIONS.titlebar);
    const navbar = await box(REGIONS.navbar);
    const header = await box(REGIONS.header);
    const pane = await box(REGIONS.pane);
    const sidebar = await box(REGIONS.sidebar);
    return {
      tab: { x: tab.x + 6, y: tab.y + tab.height - 4 },
      titlebar: { x: titlebar.x + titlebar.width * 0.45, y: titlebar.y + titlebar.height / 2 },
      navbar: { x: navbar.x + 3, y: navbar.y + navbar.height / 2 },
      header: { x: header.x + header.width - 6, y: header.y + 3 },
      pane: { x: pane.x + pane.width * 0.6, y: pane.y + pane.height - 20 },
      sidebar: { x: sidebar.x + 6, y: sidebar.y + sidebar.height - 20 },
    };
  }

  async function shotOver(page: Page, backdrop: string) {
    await page.addStyleTag({ content: `html { background: ${backdrop} !important; }` });
    return decodePng(await page.screenshot({ animations: "disabled" }));
  }

  /** Alpha and colour of every region, solved from black and white backdrops. */
  async function surfaces(page: Page): Promise<Record<Region, { alpha: number; rgb: Rgb }>> {
    const points = await probePoints(page);
    const black = await shotOver(page, "#000");
    const white = await shotOver(page, "#fff");
    const out = {} as Record<Region, { alpha: number; rgb: Rgb }>;
    for (const [name, { x, y }] of Object.entries(points) as [Region, { x: number; y: number }][]) {
      const b = black.pixel(Math.round(x), Math.round(y));
      const w = white.pixel(Math.round(x), Math.round(y));
      const alpha = 1 - (w[0] - b[0] + w[1] - b[1] + w[2] - b[2]) / 3 / 255;
      out[name] = { alpha, rgb: b.map((c) => (alpha > 0.01 ? c / alpha : 0)) as Rgb };
    }
    return out;
  }

  const near = (a: Rgb, b: Rgb) => Math.max(...a.map((c, i) => Math.abs(c - b[i])));

  for (const theme of ["dark", "light", "ocean-blue"]) {
    test(`Default fades the opaque window uniformly, the tab one with the pane (${theme}, #1789)`, async ({ page }) => {
      // As on a real Mac: the integrated title row holds the lone tab (#1756).
      await openVibrant(page, theme, "MacIntel", "default", { translucency: false, showWindowControls: true, integratedTitleBar: true });
      await expect(page.locator("html")).not.toHaveAttribute("data-material");
      const opaque = await surfaces(page);

      await applySettingsAndReload(page, { translucency: true, translucencyOpacity: 55 });
      await waitForEntries(page);
      await expect(page.locator("html")).toHaveAttribute("data-material", "vibrancy");
      const glass = await surfaces(page);

      for (const region of Object.keys(REGIONS) as Region[]) {
        // One share of the material everywhere: no surface compounds another.
        expect(glass[region].alpha, region).toBeGreaterThan(0.78);
        expect(glass[region].alpha, region).toBeLessThan(0.82);
      }
      // The tab, title bar, navigation bar and column header ARE the pane.
      for (const region of ["tab", "titlebar", "navbar", "header"] as const) {
        expect(near(glass[region].rgb, glass.pane.rgb), region).toBeLessThanOrEqual(3);
      }
      // Each surface keeps its opaque colour (the sidebar its own tone).
      expect(near(glass.pane.rgb, opaque.pane.rgb)).toBeLessThanOrEqual(3);
      expect(near(glass.sidebar.rgb, opaque.sidebar.rgb)).toBeLessThanOrEqual(3);
    });
  }

  test("the slider moves the share from glass to the opaque window (#1789)", async ({ page }) => {
    await openVibrant(page, "dark", "MacIntel", "default", { translucencyOpacity: 20, showWindowControls: true, integratedTitleBar: true });
    const glass = await surfaces(page);
    await applySettingsAndReload(page, { translucencyOpacity: 100 });
    await waitForEntries(page);
    const solid = await surfaces(page);
    for (const region of Object.keys(REGIONS) as Region[]) {
      expect(glass[region].alpha, region).toBeGreaterThan(0.57);
      expect(glass[region].alpha, region).toBeLessThan(0.63);
      expect(solid[region].alpha, region).toBeGreaterThan(0.98);
    }
    // Translucency on does not paint the window body itself: the surfaces do.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".explorer")!).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  });

  test("Floating Islands paints its own window body: light 15%, dark 30% (#1734)", async ({ page }) => {
    // Islands nudge the body toward the accent and use their own dark
    // coverage, so the wallpaper still shows between dark islands.
    await openVibrant(page, "dark", "MacIntel", "floating-islands");
    const dark = await tint(page, "var(--islands-body-color)");
    expect(dark.body).toBe(dark.islandsDark);
    expect(dark.body).not.toBe((await tint(page)).dark);

    await applySettingsAndReload(page, { theme: "light" });
    await waitForEntries(page);
    const light = await tint(page, "var(--islands-body-color)");
    expect(light.body).toBe(light.light);
  });

  test("a theme's own tint wins on Floating Islands: Tahoe's lighter lavender wash", async ({ page }) => {
    await openVibrant(page, "tahoe", "MacIntel", "floating-islands");
    const { body } = await tint(page);
    expect(body).toBe("rgba(170, 190, 255, 0.12)");
  });

  test("a layout's own window surface wins over the tint", async ({ page }) => {
    await openVibrant(page, "dark");
    await page.evaluate(() => document.documentElement.style.setProperty("--layout-app-surface", "rgb(1, 2, 3)"));
    const { body } = await tint(page);
    expect(body).toBe("rgb(1, 2, 3)");
  });

  test("on Linux the translucency setting adds no tint", async ({ page }) => {
    await openVibrant(page, "dark", "Linux x86_64");
    await expect(page.locator("html")).not.toHaveAttribute("data-material");
    // No material: the window keeps the opaque theme, not the translucent tint.
    const { body, dark } = await tint(page);
    expect(body).not.toBe(dark);
    expect(body).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("translucency off adds no tint: the window stays the opaque theme", async ({ page }) => {
    await openVibrant(page, "dark");
    await applySettingsAndReload(page, { translucency: false });
    await waitForEntries(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-material");
    const opaque = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(opaque).not.toBe("rgba(0, 0, 0, 0)");
  });

});
