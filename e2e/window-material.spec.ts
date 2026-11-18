/**
 * E2E: a window shows the material it was built with (#1757).
 *
 * A window's material is fixed when it is created. Its creator puts it in the
 * window's URL (`material=`, or Rust's `__WINDOW_MATERIAL__` for the main
 * window), so the page follows that rather than settings that may have
 * changed since. The opaque theme colour app.html paints before boot must
 * not cover a translucent window's material.
 */
import { test, expect, type Page } from "./fixtures";
import { seedSettings, waitForEntries } from "./helpers";

/** What app.html paints inline before boot: an opaque cached theme colour. */
const CACHED_BG = "rgb(1, 2, 3)";

async function open(page: Page, search: string, translucency: boolean) {
  await page.addInitScript((bg) => {
    // Only before the first load: a reload must see what the page left.
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("explorer-bg", bg);
    }
  }, CACHED_BG);
  await seedSettings(page, { layoutTheme: "floating-islands", theme: "dark", translucency });
  await page.goto(`/?path=/home/user&${search}`);
  await waitForEntries(page);
}

const html = (page: Page) => page.locator("html");
const inlineBackground = (page: Page) => page.evaluate(() => document.documentElement.style.background);

test.describe("window material from its creator (#1757)", () => {
  test("a window built translucent shows its material, uncovered, though settings now say off", async ({ page }) => {
    await open(page, "material=acrylic", false);

    await expect(html(page)).toHaveAttribute("data-material", "acrylic");
    await expect(html(page)).toHaveAttribute("data-native-backdrop", "");
    expect(await inlineBackground(page)).toBe("");
    // The page body is transparent, so the material shows through it.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    // Its transparent body never replaces the opaque colour the next opaque
    // window paints before boot.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => localStorage.getItem("explorer-bg"))).toBe(CACHED_BG);

    // A reload (or renderer recovery, which keeps the URL) keeps it.
    await page.reload();
    await waitForEntries(page);
    await expect(html(page)).toHaveAttribute("data-material", "acrylic");
  });

  test("a window built opaque stays opaque, with its pre-paint colour, though settings now say on", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel", configurable: true });
    });
    await open(page, "material=none", true);

    await expect(html(page)).not.toHaveAttribute("data-material", /.*/);
    await expect(html(page)).not.toHaveAttribute("data-native-backdrop", /.*/);
    expect(await inlineBackground(page)).toContain(CACHED_BG);
  });
});
