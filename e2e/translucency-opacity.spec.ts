/**
 * E2E: Translucency Opacity setting (#1735). One slider, shown only on macOS
 * with Native Blur, drives the Floating Islands coverage variables inline.
 */
import { test, expect, type Page } from "./fixtures";
import { pressShortcut, seedSettings, waitForEntries } from "./helpers";

test.describe("Translucency Opacity (#1735)", () => {
  async function open(page: Page, { platform = "MacIntel", vibrancyBlur = true, theme = "dark", extra = {} } = {}) {
    await page.addInitScript((value) => {
      Object.defineProperty(window.navigator, "platform", { get: () => value, configurable: true });
    }, platform);
    await seedSettings(page, {
      layoutTheme: "floating-islands",
      theme,
      macOsVibrancy: true,
      vibrancyBlur,
      ...extra,
    });
    await page.goto("/");
    await waitForEntries(page);
  }

  async function openSettings(page: Page) {
    await pressShortcut(page, ",", { ctrlKey: true });
    await expect(page.locator(".settings-dialog")).toBeVisible();
  }

  /** The island fill as the page computes it (a probe painted with the variable). */
  async function islandAlpha(page: Page): Promise<number> {
    return page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--islands-fill)";
      document.documentElement.appendChild(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      // `rgba(r, g, b, a)` or the modern `color(srgb r g b / a)`; no alpha = opaque.
      const slash = /\/\s*([\d.]+%?)\s*\)/.exec(colour);
      const comma = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/.exec(colour);
      const raw = slash?.[1] ?? comma?.[1];
      if (raw === undefined) return 1;
      return raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    });
  }

  const slider = (page: Page) => page.locator(".translucency-opacity-input");

  test("moving the slider changes the island fill alpha live and persists", async ({ page }) => {
    await open(page);
    await expect(page.locator("html")).toHaveAttribute("data-macos-material", "");
    // Default 55% = today's dark defaults: alpha 1 - 0.455 / 0.7.
    expect(await islandAlpha(page)).toBeCloseTo(0.35, 2);

    await openSettings(page);
    await expect(slider(page)).toHaveValue("55");
    await slider(page).fill("20");
    // Dark island coverage 0.2 over body 0.11: alpha ~ 0.101.
    await expect.poll(() => islandAlpha(page)).toBeCloseTo(0.101, 2);
    const seeThrough = await islandAlpha(page);

    await slider(page).fill("100");
    await expect.poll(() => islandAlpha(page)).toBeCloseTo(1, 2);
    expect(await islandAlpha(page)).toBeGreaterThan(seeThrough);

    await slider(page).fill("20");
    await page.reload();
    await waitForEntries(page);
    expect(await islandAlpha(page)).toBeCloseTo(0.101, 2);
  });

  test("light themes change too and stay readable", async ({ page }) => {
    await open(page, { theme: "light" });
    const normal = await islandAlpha(page);
    await openSettings(page);
    await slider(page).fill("20");
    // The theme's panel colour carries its own alpha, so compare relatively:
    // light island alpha goes 0.98 -> 0.79 (x0.8), more see-through but readable.
    await expect.poll(async () => (await islandAlpha(page)) / normal).toBeLessThan(0.9);
    expect((await islandAlpha(page)) / normal).toBeGreaterThan(0.7);
  });

  test("the setting beats a theme's own coverage values", async ({ page }) => {
    await open(page, { extra: { translucencyOpacity: 100 } });
    // A stylesheet value (a theme) loses to the inline setting.
    await page.addStyleTag({ content: ":root { --island-coverage-dark: 0.1; }" });
    expect(await islandAlpha(page)).toBeCloseTo(1, 2);
  });

  test("off macOS the row is absent and no coverage variables are set", async ({ page }) => {
    await open(page, { platform: "Linux x86_64" });
    await openSettings(page);
    await expect(page.getByText("Translucency Opacity")).toHaveCount(0);
    const inline = await page.evaluate(() => document.documentElement.style.getPropertyValue("--island-coverage-dark"));
    expect(inline).toBe("");
  });

  test("with Native Blur off the row is absent and variables are removed", async ({ page }) => {
    await open(page, { vibrancyBlur: false });
    await openSettings(page);
    await expect(page.getByText("Translucency Opacity")).toHaveCount(0);
    const inline = await page.evaluate(() => document.documentElement.style.getPropertyValue("--island-coverage"));
    expect(inline).toBe("");
  });

  test("screenshot: Appearance > Translucency Opacity", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await open(page, { extra: { translucencyOpacity: 40 } });
    await openSettings(page);
    await slider(page).scrollIntoViewIfNeeded();
    await expect(slider(page)).toBeVisible();
    await page.screenshot({
      path: "screenshots/feat/translucency-opacity/settings-slider.png",
      animations: "disabled",
    });
  });
});
