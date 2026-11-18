/**
 * Context menus inside Floating Islands (#1734).
 *
 * An island with a backdrop-filter (or transform) becomes the containing
 * block for the `position: fixed` menu inside it, so the menu opened offset
 * by the island's own position. The island under the active tab also clips
 * itself (the seam notch), which makes it a stacking context: a menu that
 * overhangs a later sibling island must still paint above it. Menus are
 * opaque: a backdrop filter never sampled the native window material.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, pressShortcut, seedSettings, waitForEntries } from "./helpers";

const MATERIALS = [
  { name: "opaque window", platform: undefined, settings: {} },
  { name: "macOS material", platform: "MacIntel", settings: { macOsVibrancy: true, vibrancyBlur: true } },
] as const;

async function openIslands(page: Page, material: (typeof MATERIALS)[number]): Promise<void> {
  if (material.platform) {
    await page.addInitScript((value) => {
      Object.defineProperty(window.navigator, "platform", { get: () => value, configurable: true });
    }, material.platform);
  }
  await seedSettings(page, {
    layoutTheme: "floating-islands",
    showPreviewPane: true,
    previewPanePosition: "right",
    viewMode: "details",
    ...material.settings,
  });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  if (material.platform) await expect(page.locator("html")).toHaveAttribute("data-macos-material", "");
}

for (const material of MATERIALS) {
  test(`context menu opens at the pointer and above later islands (${material.name})`, async ({ page }) => {
    await openIslands(page, material);
    // Two new tabs: the active third tab stands over the panes island, which
    // then carries the seam notch (a clip-path) under it.
    await pressShortcut(page, "t", { ctrlKey: true });
    await pressShortcut(page, "t", { ctrlKey: true });
    await expect(page.locator('.tab-viewport [data-region="tab"]')).toHaveCount(3);
    await page.locator(".pane-tree:not(.retained) .entry-item:visible").first().waitFor();
    const panes = page.locator('[data-region="panes"]:visible').first();
    await expect(panes).toHaveAttribute("data-tab-seam", "");
    const preview = page.locator('[data-region="preview"]:visible').first();
    await expect(preview).toBeVisible();

    // Right-click a row near the panes island's right edge, so the menu
    // overhangs the preview island beside it.
    const paneBox = (await panes.boundingBox())!;
    const row = page.locator(".pane-tree:not(.retained) .entry-item:visible").nth(1);
    const rowBox = (await row.boundingBox())!;
    const point = { x: Math.round(paneBox.x + paneBox.width - 60), y: Math.round(rowBox.y + rowBox.height / 2) };
    await page.mouse.click(point.x, point.y, { button: "right" });
    const menu = page.locator(".context-menu.revealed");
    await expect(menu).toBeVisible();

    await expect.poll(async () => {
      const box = (await menu.boundingBox())!;
      return Math.max(Math.abs(box.x - point.x), Math.abs(box.y - point.y));
    }).toBeLessThanOrEqual(2);

    // The part of the menu over the preview island is the menu's, not the
    // preview's: hit-testing follows paint order.
    const box = (await menu.boundingBox())!;
    const previewBox = (await preview.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(previewBox.x + 20);
    const probe = { x: previewBox.x + 10, y: box.y + box.height / 2 };
    const onTop = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit?.closest(".context-menu"));
    }, probe);
    expect(onTop).toBe(true);

    // Opaque: no backdrop filter, and a fully opaque base colour.
    const surface = await menu.evaluate((el) => {
      const style = getComputedStyle(el);
      return { filter: style.backdropFilter || "none", color: style.backgroundColor };
    });
    expect(surface.filter).toBe("none");
    expect(surface.color).toMatch(/^rgb\(/);

    if (material.platform) {
      await page.screenshot({ path: "screenshots/feat/islands-tab-owns-window/context-menu.png", animations: "disabled" });
    }
  });
}

test("modal cards are opaque under Floating Islands", async ({ page }) => {
  await openIslands(page, MATERIALS[1]);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await page.keyboard.press("Control+Shift+p");
  await palette.getByPlaceholder("Type a command...").fill("About");
  await expect(palette.locator(".command-label")).toHaveText("About");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "About Tauri Explorer", exact: true })).toBeVisible();
  const card = page.locator(".modal-card:visible").first();
  await expect(card).toBeVisible();
  const surface = await card.evaluate((el) => {
    const style = getComputedStyle(el);
    return { filter: style.backdropFilter || "none", color: style.backgroundColor };
  });
  expect(surface.filter).toBe("none");
  expect(surface.color).toMatch(/^rgb\(/);
});
