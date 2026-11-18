/**
 * E2E: Translucency Opacity setting (#1735, #1757). One slider, shown wherever the
 * unified Translucency setting is on (macOS and Windows), drives the Floating Islands coverage variables inline.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, applySettingsAndReload, pressShortcut, seedSettings, waitForEntries } from "./helpers";

test.describe("Translucency Opacity (#1735)", () => {
  async function open(page: Page, { platform = "MacIntel", translucency = true, theme = "dark", extra = {} } = {}) {
    await page.addInitScript((value) => {
      Object.defineProperty(window.navigator, "platform", { get: () => value, configurable: true });
    }, platform);
    await seedSettings(page, {
      layoutTheme: "floating-islands",
      theme,
      translucency,
      ...extra,
    });
    await page.goto("/");
    // A simulated Windows page rewrites paths to backslashes, which the POSIX
    // mock filesystem cannot list: there are no rows to wait for.
    if (platform.startsWith("Win")) await expect(page.locator(".explorer").first()).toBeVisible();
    else await waitForEntries(page);
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
    await expect(page.locator("html")).toHaveAttribute("data-material", "vibrancy");
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

  test("on Linux with translucency on: no material, no backdrop, no Translucency row", async ({ page }) => {
    await open(page, { platform: "Linux x86_64" });
    const html = page.locator("html");
    await expect(html).not.toHaveAttribute("data-material");
    await expect(html).not.toHaveAttribute("data-native-backdrop");
    await openSettings(page);
    await expect(page.locator(".setting-label", { hasText: /^Translucency$/ })).toHaveCount(0);
    await expect(page.getByText("Translucency Opacity")).toHaveCount(0);
    const inline = await page.evaluate(() => document.documentElement.style.getPropertyValue("--island-coverage-dark"));
    expect(inline).toBe("");
  });

  test("with translucency off the opacity row is absent and variables are removed", async ({ page }) => {
    await open(page, { translucency: false });
    await openSettings(page);
    // The toggle row stays (macOS), the slider row is gone.
    await expect(page.locator(".setting-label", { hasText: /^Translucency$/ })).toHaveCount(1);
    await expect(page.getByText("Translucency Opacity")).toHaveCount(0);
    const inline = await page.evaluate(() => document.documentElement.style.getPropertyValue("--island-coverage"));
    expect(inline).toBe("");
  });

  test("a runtime toggle does not change the live window; a reload applies it", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel", configurable: true });
    });
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { layoutTheme: "floating-islands", translucency: false });
    await waitForEntries(page);
    const html = page.locator("html");
    await expect(html).not.toHaveAttribute("data-material");

    await openSettings(page);
    await page.locator(".setting-row", { has: page.locator(".setting-label", { hasText: /^Translucency$/ }) }).locator(".toggle").click();
    await expect(slider(page)).toBeVisible();
    // The native window was created without a material: the page keeps its attributes.
    await expect(html).not.toHaveAttribute("data-material");
    await expect(html).not.toHaveAttribute("data-native-backdrop");

    await page.keyboard.press("Escape");
    await page.reload();
    await waitForEntries(page);
    await expect(html).toHaveAttribute("data-material", "vibrancy");
    await expect(html).toHaveAttribute("data-native-backdrop", "");

    // And back: turned off, the next window (here the reload) has no material.
    await applySettingsAndReload(page, { translucency: false });
    await waitForEntries(page);
    await expect(html).not.toHaveAttribute("data-material");
  });

  test.describe("Windows (acrylic)", () => {
    test("material, transparent body, coverage vars and the slider match macOS", async ({ page }) => {
      await open(page, { platform: "Win32" });
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-material", "acrylic");
      await expect(html).toHaveAttribute("data-native-backdrop", "");
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      const vars = await page.evaluate(() => {
        const style = document.documentElement.style;
        return ["--island-coverage-dark", "--material-window-coverage", "--material-window-coverage-dark"]
          .map((name) => style.getPropertyValue(name));
      });
      for (const value of vars) expect(value).not.toBe("");

      expect(await islandAlpha(page)).toBeCloseTo(0.35, 2);
      await openSettings(page);
      await slider(page).fill("20");
      await expect.poll(() => islandAlpha(page)).toBeCloseTo(0.101, 2);
      await slider(page).fill("100");
      await expect.poll(() => islandAlpha(page)).toBeCloseTo(1, 2);
    });

    test("Settings shows one Translucency toggle and no backdrop rows", async ({ page }) => {
      await open(page, { platform: "Win32" });
      await openSettings(page);
      await expect(page.locator(".setting-label", { hasText: /^Translucency$/ })).toHaveCount(1);
      await expect(slider(page)).toBeVisible();
      await expect(page.getByText("Window Backdrop")).toHaveCount(0);
      await expect(page.getByText("Backdrop Opacity")).toHaveCount(0);
    });
  });

  for (const [label, platform] of [["macos", "MacIntel"], ["windows", "Win32"]] as const) {
    test(`screenshot: Appearance > Translucency (${label})`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 760 });
      await open(page, { platform, extra: { translucencyOpacity: 40 } });
      await openSettings(page);
      await slider(page).scrollIntoViewIfNeeded();
      await expect(page.locator(".setting-label", { hasText: /^Translucency$/ })).toBeVisible();
      await expect(slider(page)).toBeVisible();
      await page.screenshot({
        path: `screenshots/feat/unified-translucency/settings-${label}.png`,
        animations: "disabled",
      });
    });
  }
});
