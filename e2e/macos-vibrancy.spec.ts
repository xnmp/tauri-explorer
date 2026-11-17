/**
 * E2E test: macOS vibrancy setting.
 * Issue: feat/macos-vibrancy, #1306 (native backdrop is independent of layout)
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, applySettingsAndReload, waitForEntries } from "./helpers";

test.describe("macOS vibrancy", () => {
  test("data-native-backdrop is set when macOsVibrancy is enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: true });
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-native-backdrop", "");
  });

  test("data-native-backdrop is absent when macOsVibrancy is disabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: false });
    await waitForEntries(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-native-backdrop");
  });

  test("vibrancy CSS makes body transparent when enabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, { macOsVibrancy: true });
    await waitForEntries(page);

    const bodyBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );
    expect(bodyBg).toBe("rgba(0, 0, 0, 0)");
  });

  test("native backdrop works under every layout, including Default", async ({ page }) => {
    await page.goto(HOME_URL);
    for (const layoutTheme of ["default", "floating-islands", "hairline-ledger", "compact", "soft-cards"]) {
      await applySettingsAndReload(page, { macOsVibrancy: true, layoutTheme });
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
 * #1733: under the macOS material the page paints a tint of the theme base
 * over the window, so the palette survives the grey material: about 15% on
 * light themes and 55% on dark ones. The browser cannot show the native
 * material, so the window "behind" is simulated by an html background.
 */
test.describe("theme tint over the macOS material (#1733)", () => {
  const SIMULATED_MATERIAL = `
    html {
      background:
        linear-gradient(rgba(128, 128, 128, 0.55), rgba(128, 128, 128, 0.55)),
        radial-gradient(70% 90% at 15% 20%, #e8875a 0%, transparent 60%),
        radial-gradient(60% 80% at 85% 75%, #3f7fd6 0%, transparent 65%),
        linear-gradient(135deg, #5b3c88, #1f6f6b) !important;
      /* The root box can be shorter than the viewport; size the images to it. */
      background-attachment: fixed !important;
    }`;

  async function openVibrant(page: Page, theme: string, platform = "MacIntel"): Promise<void> {
    await page.addInitScript((value) => {
      Object.defineProperty(window.navigator, "platform", { get: () => value, configurable: true });
    }, platform);
    await page.goto(HOME_URL);
    await applySettingsAndReload(page, {
      macOsVibrancy: true,
      vibrancyBlur: true,
      layoutTheme: "floating-islands",
      theme,
    });
    await waitForEntries(page);
  }

  /** The window body's paint, and what the given share of the theme base
   *  computes to in the same document (same serialization). */
  async function tint(page: Page) {
    return page.evaluate(() => {
      const mix = (share: number) => {
        const probe = document.createElement("div");
        probe.style.background = `color-mix(in srgb, var(--background-solid) ${share}%, transparent)`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      };
      return {
        body: getComputedStyle(document.querySelector(".explorer")!).backgroundColor,
        light: mix(15),
        dark: mix(55),
      };
    });
  }

  test("dark themes paint 55% of the theme base over the material", async ({ page }) => {
    await openVibrant(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-macos-material", "");
    const { body, light, dark } = await tint(page);
    expect(light).not.toBe(dark);
    expect(body).toBe(dark);

    await page.addStyleTag({ content: SIMULATED_MATERIAL });
    await page.screenshot({
      path: "screenshots/feat/macos-vibrancy-material/vibrancy-tint-dark.png",
      animations: "disabled",
    });
  });

  test("light themes paint 15% of the theme base over the material", async ({ page }) => {
    await openVibrant(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-macos-material", "");
    const { body, light, dark } = await tint(page);
    expect(light).not.toBe(dark);
    expect(body).toBe(light);

    await page.addStyleTag({ content: SIMULATED_MATERIAL });
    await page.screenshot({
      path: "screenshots/feat/macos-vibrancy-material/vibrancy-tint-light.png",
      animations: "disabled",
    });
  });

  test("a theme's own tint wins: Tahoe's lighter lavender wash", async ({ page }) => {
    await openVibrant(page, "tahoe");
    const { body } = await tint(page);
    expect(body).toBe("rgba(170, 190, 255, 0.12)");
  });

  test("a layout's own window surface wins over the tint", async ({ page }) => {
    await openVibrant(page, "dark");
    await page.evaluate(() => document.documentElement.style.setProperty("--layout-app-surface", "rgb(1, 2, 3)"));
    const { body } = await tint(page);
    expect(body).toBe("rgb(1, 2, 3)");
  });

  test("off macOS the vibrancy setting adds no tint", async ({ page }) => {
    await openVibrant(page, "dark", "Linux x86_64");
    await expect(page.locator("html")).not.toHaveAttribute("data-macos-material");
    expect((await tint(page)).body).toBe("rgba(0, 0, 0, 0)");
  });

  test("Native Blur off adds no tint: the window stays the opaque theme", async ({ page }) => {
    await openVibrant(page, "dark");
    await applySettingsAndReload(page, { vibrancyBlur: false });
    await waitForEntries(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-macos-material");
    const opaque = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(opaque).not.toBe("rgba(0, 0, 0, 0)");
  });
});
