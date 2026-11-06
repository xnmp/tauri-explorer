/**
 * E2E: plugin file icons and Details columns (#1523), through the demo
 * plugin's `.demorec` recordings in demo://. Asserts what the user sees:
 * the contributed icon in every view, the plugin columns' header and row
 * values, the Length fallback, the Type name, hiding a column from the header
 * menu, columns absent from folders without matching files, and removal when
 * the plugin is disabled.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, runPaletteCommand, switchViewMode, waitForEntries } from "./helpers";

const MATCHUP = '[data-cell="demo.recording-header:matchup"]';
const MAP = '[data-cell="demo.recording-header:map"]';

async function setDemoPluginEnabled(page: Page, enabled: boolean) {
  await page.keyboard.press("Control+,");
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const dialog = page.locator(".plugins-dialog");
  await expect(dialog).toBeVisible();
  const row = dialog.locator('.setting-row:has-text("Demo Plugin")').first();
  const toggle = row.locator('input[type="checkbox"]').first();
  if ((await toggle.isChecked()) !== enabled) await row.locator("label.toggle").click();
  await expect(toggle).toBeChecked({ checked: enabled });
  await page.locator(".plugins-dialog .close-btn").click();
  await expect(dialog).toBeHidden();
}

async function openDemoFolder(page: Page) {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await setDemoPluginEnabled(page, true);
  await runPaletteCommand(page, "Demo: Open Virtual Folder");
  await expect(row(page, "final-game.demorec")).toBeVisible();
}

// Retained tabs stay mounted while hidden (#1173): scope to what is shown.
const row = (page: Page, name: string) => page.locator(`.entry-item[data-path="demo://${name}"]:visible`);
const headers = (page: Page) => page.locator(".column-headers:visible");

test.describe("plugin file icons and Details columns (#1523)", () => {
  test("Details shows the plugin icon, type, columns and Length for matching files only", async ({ page }) => {
    // Wide enough that the evidence shot shows the trailing plugin columns.
    await page.setViewportSize({ width: 1720, height: 640 });
    await openDemoFolder(page);
    await switchViewMode(page, "details");

    await expect(headers(page).getByText("Matchup", { exact: true })).toBeVisible();
    await expect(headers(page).getByText("Map", { exact: true })).toBeVisible();

    const game = row(page, "final-game.demorec");
    await expect(game.locator(MATCHUP)).toHaveText("PvZ");
    await expect(game.locator(MAP)).toHaveText("Fighting Spirit");
    await expect(game.locator('[data-cell="length"]')).toHaveText("12:14");
    await expect(game.locator('[data-cell="type"]')).toHaveText("Demo recording");
    const icon = game.locator("img.plugin-file-icon");
    await expect(icon).toBeVisible();
    // The SVG actually decoded (an <img> without the SVG namespace stays blank).
    await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(row(page, "practice.demorec").locator(MATCHUP)).toHaveText("TvT");

    // A non-matching file keeps its built-in icon, type and empty plugin cells.
    const hello = row(page, "hello.txt");
    await expect(hello.locator("img.plugin-file-icon")).toHaveCount(0);
    await expect(hello.locator(MATCHUP)).toHaveText("");
    await expect(hello.locator('[data-cell="type"]')).not.toHaveText("Demo recording");

    // Header cells and row cells share one grid: the Matchup header sits above its cells.
    const header = await headers(page).getByText("Matchup", { exact: true }).boundingBox();
    const cell = await game.locator(MATCHUP).boundingBox();
    expect(header && cell && Math.abs(header.x - cell.x)).toBeLessThan(24);

    await page.screenshot({ path: "screenshots/feat/plugin-file-icons-and-detail-columns/details-plugin-columns.png", animations: "disabled" });
  });

  test("a plugin column can be hidden and restored from the header menu", async ({ page }) => {
    await openDemoFolder(page);
    await switchViewMode(page, "details");
    const game = row(page, "final-game.demorec");
    await expect(game.locator(MATCHUP)).toHaveText("PvZ");

    await headers(page).click({ button: "right" });
    await page.locator(".column-menu-item", { hasText: "Matchup" }).click();
    await expect(headers(page).getByText("Matchup", { exact: true })).toHaveCount(0);
    await expect(game.locator(MATCHUP)).toHaveCount(0);
    await expect(game.locator(MAP)).toHaveText("Fighting Spirit");

    await headers(page).click({ button: "right" });
    await page.locator(".column-menu-item", { hasText: "Matchup" }).click();
    await expect(headers(page).getByText("Matchup", { exact: true })).toBeVisible();
    await expect(game.locator(MATCHUP)).toHaveText("PvZ");
  });

  test("folders without matching files offer no plugin columns", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await setDemoPluginEnabled(page, true);
    await switchViewMode(page, "details");
    await expect(page.locator(".entry-item:visible").first()).toBeVisible();
    await expect(headers(page).getByText("Matchup", { exact: true })).toHaveCount(0);
    await headers(page).click({ button: "right" });
    await expect(page.locator(".column-menu-item", { hasText: "Size" })).toBeVisible();
    await expect(page.locator(".column-menu-item", { hasText: "Matchup" })).toHaveCount(0);
  });

  for (const mode of ["list", "tiles"] as const) {
    test(`the plugin icon replaces the built-in icon in ${mode}`, async ({ page }) => {
      await openDemoFolder(page);
      await switchViewMode(page, mode);
      const icon = row(page, "final-game.demorec").locator("img.plugin-file-icon");
      await expect(icon).toBeVisible();
      await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      // A CSS filter on an <img> is re-rasterized every scroll frame in
      // WebKitGTK; plugin icons must not inherit the icon drop shadow (#1530).
      expect(await icon.evaluate((img) => getComputedStyle(img).filter)).toBe("none");
      await expect(row(page, "hello.txt").locator("img.plugin-file-icon")).toHaveCount(0);
      await page.screenshot({ path: `screenshots/feat/plugin-file-icons-and-detail-columns/${mode}-plugin-icon.png`, animations: "disabled" });
    });
  }

  test("disabling the plugin removes its icon and columns", async ({ page }) => {
    await openDemoFolder(page);
    await switchViewMode(page, "details");
    await expect(row(page, "final-game.demorec").locator("img.plugin-file-icon")).toBeVisible();
    // Disabling also unregisters demo://; whatever the pane lists afterwards,
    // no plugin icon or column may remain anywhere in the window.
    await setDemoPluginEnabled(page, false);
    await expect(page.locator("img.plugin-file-icon")).toHaveCount(0);
    await expect(headers(page).getByText("Matchup", { exact: true })).toHaveCount(0);
  });
});
