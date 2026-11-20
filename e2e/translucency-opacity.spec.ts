/**
 * E2E: Translucency Opacity setting (#1735, #1757). One slider, shown wherever the
 * unified Translucency setting is on (macOS and Windows), drives the Floating Islands coverage variables inline.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, applySettingsAndReload, pressShortcut, seedSettings, waitForEntries } from "./helpers";
import { colourDistance, materialShot, type Painted } from "./material-pixels";

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

  /**
   * What the islands paint, from pixels (#1789 review): the share of the
   * material the content island, the sidebar island and the window body hide
   * in total, and their colours. Points sit near each island's bottom, away
   * from rows; the body point is left of the sidebar, where no island shadow
   * falls (they fall right and down).
   */
  async function islands(page: Page): Promise<{ island: Painted; sidebar: Painted; body: Painted }> {
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const panes = await box('[data-region="panes"]');
    const sidebar = await box('[data-region="sidebar"]');
    const shot = await materialShot(page);
    return {
      island: shot.at(panes.x + panes.width * 0.6, panes.y + panes.height - 30),
      sidebar: shot.at(sidebar.x + 20, sidebar.y + sidebar.height - 30),
      body: shot.at(sidebar.x - 3, sidebar.y + sidebar.height / 2),
    };
  }

  /** The content island's share of the material, from pixels. */
  const islandAlpha = async (page: Page) => (await islands(page)).island.alpha;

  const slider = (page: Page) => page.locator(".translucency-opacity-input");

  /** Moves the slider in Settings, then closes it (its backdrop covers the islands). */
  async function setSlider(page: Page, value: number) {
    if (!(await page.locator(".settings-dialog").isVisible())) await openSettings(page);
    await slider(page).fill(String(value));
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-dialog")).toBeHidden();
  }

  test("moving the slider changes the islands' share live and persists", async ({ page }) => {
    await open(page);
    await expect(page.locator("html")).toHaveAttribute("data-material", "vibrancy");
    // The dark island hides its coverage: 0.545 at the default.
    expect(await islandAlpha(page)).toBeCloseTo(0.545, 1);

    await openSettings(page);
    await expect(slider(page)).toHaveValue("55");
    await setSlider(page, 20);
    await expect.poll(() => islandAlpha(page)).toBeLessThan(0.22);
    expect(await islandAlpha(page)).toBeGreaterThan(0.18);
    const seeThrough = await islandAlpha(page);

    await setSlider(page, 100);
    await expect.poll(() => islandAlpha(page)).toBeGreaterThan(0.99);
    expect(await islandAlpha(page)).toBeGreaterThan(seeThrough);

    await setSlider(page, 20);
    await page.reload();
    await waitForEntries(page);
    expect(Math.abs((await islandAlpha(page)) - 0.2)).toBeLessThanOrEqual(0.02);
  });

  test("light themes change too and stay readable", async ({ page }) => {
    await open(page, { theme: "light" });
    const normal = await islandAlpha(page);
    await setSlider(page, 20);
    await expect.poll(async () => (await islandAlpha(page)) / normal).toBeLessThan(0.9);
    expect((await islandAlpha(page)) / normal).toBeGreaterThan(0.6);
  });

  test("the setting beats a theme's own coverage values", async ({ page }) => {
    await open(page, { extra: { translucencyOpacity: 81 } });
    // A stylesheet value (a theme) loses to the inline setting.
    await page.addStyleTag({ content: ":root { --island-coverage-dark: 0.1; }" });
    expect(Math.abs((await islandAlpha(page)) - 0.808)).toBeLessThanOrEqual(0.02);
  });

  /**
   * #1789 review: each island is one layer, so it hides exactly its coverage
   * (a base layer under a translucent panel compounded: dark islands hid
   * 0.64 at the default), in the theme's own island colour: its card over its
   * base, as with Translucency off.
   */
  for (const theme of ["dark", "ocean-blue"]) {
    test(`dark islands hide exactly their coverage in the theme's own colours (${theme})`, async ({ page }) => {
      // Translucency off, in a page of its own (the seeded settings re-apply on every load).
      const off = await page.context().newPage();
      await open(off, { theme, translucency: false });
      const opaque = await islands(off);
      await off.close();
      for (const [value, island, sidebar] of [[20, 0.2, 0.176], [55, 0.545, 0.48], [81, 0.808, 0.712]] as const) {
        const glassPage = await page.context().newPage();
        await open(glassPage, { theme, extra: { translucencyOpacity: value } });
        const glass = await islands(glassPage);
        await glassPage.close();
        expect(Math.abs(glass.island.alpha - island), `${value}%: island share ${glass.island.alpha}`).toBeLessThanOrEqual(0.015);
        expect(Math.abs(glass.sidebar.alpha - sidebar), `${value}%: sidebar share ${glass.sidebar.alpha}`).toBeLessThanOrEqual(0.015);
        if (value >= 55) {
          // Over the body's tint the island's colour moves a little toward it.
          expect(colourDistance(glass.island.rgb, opaque.island.rgb), `${value}%: island colour`).toBeLessThanOrEqual(6);
        }
      }
    });
  }

  /** v0.29 rendered these on the default share; light islands are their themes' translucent colour (#1789 review). */
  for (const [theme, island, sidebar] of [["light", 0.396, 0.329], ["tahoe", 0.549, 0.435], ["solarized-light", 0.396, 0.329]] as const) {
    test(`light islands look as they did in v0.29 (${theme})`, async ({ page }) => {
      await open(page, { theme });
      const glass = await islands(page);
      expect(Math.abs(glass.island.alpha - island), `island share ${glass.island.alpha}`).toBeLessThanOrEqual(0.015);
      expect(Math.abs(glass.sidebar.alpha - sidebar), `sidebar share ${glass.sidebar.alpha}`).toBeLessThanOrEqual(0.015);
    });
  }

  for (const theme of ["dark", "light", "tahoe"]) {
    test(`100% is solid: islands, sidebar and window body (${theme})`, async ({ page }) => {
      await open(page, { theme, extra: { translucencyOpacity: 100 } });
      const glass = await islands(page);
      for (const [name, painted] of Object.entries(glass)) {
        expect(painted.alpha, `${name} share at 100%`).toBeGreaterThanOrEqual(0.99);
      }
    });
  }

  test("a v0.29 settings file keeps its look: a migrated 65% Windows backdrop stays 0.65 over the body", async ({ page }) => {
    // What v0.29 wrote after migrating `windowsBackdropOpacity: 65` (#1757):
    // settings version 3 with the slider at 81. v0.29 painted the island at
    // 0.808 of the material in total (alpha 0.654 over a 0.445 body).
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel", configurable: true });
      localStorage.setItem("explorer-settings", JSON.stringify({
        settingsVersion: 3, translucency: true, translucencyOpacity: 81, layoutTheme: "floating-islands", theme: "dark",
      }));
    });
    await page.goto("/");
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-material", "vibrancy");
    const glass = await islands(page);
    expect(Math.abs(glass.island.alpha - 0.808), `island share ${glass.island.alpha}`).toBeLessThanOrEqual(0.015);
    expect(Math.abs(glass.sidebar.alpha - 0.712), `sidebar share ${glass.sidebar.alpha}`).toBeLessThanOrEqual(0.015);
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

      expect(await islandAlpha(page)).toBeCloseTo(0.545, 1);
      await setSlider(page, 20);
      await expect.poll(() => islandAlpha(page)).toBeLessThan(0.22);
      await setSlider(page, 100);
      await expect.poll(() => islandAlpha(page)).toBeGreaterThan(0.99);
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
