/**
 * E2E: PgUp/PgDn move the highlighted row by 10 in Quick Open and the command
 * palette, clamping at the ends (#1419).
 */
import type { Locator } from "@playwright/test";
import { test, expect, type Page } from "./fixtures";

const rowIndex = (rows: Locator) =>
  rows.evaluateAll((els) => els.findIndex((e) => e.classList.contains("selected")));

async function expectSelectedVisible(list: Locator, selected: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const l = await list.boundingBox();
      const s = await selected.boundingBox();
      return !!l && !!s && s.y >= l.y - 1 && s.y + s.height <= l.y + l.height + 1;
    })
    .toBe(true);
}

async function exercise(page: Page, dialog: Locator, rows: Locator, list: Locator) {
  const count = await rows.count();
  expect(count).toBeGreaterThan(20);
  await expect.poll(() => rowIndex(rows)).toBe(0);

  await page.keyboard.press("PageDown");
  await expect.poll(() => rowIndex(rows)).toBe(10);
  await expectSelectedVisible(list, dialog.locator(".selected"));
  await page.screenshot({ path: "screenshots/feat/palette-page-keys/pgdn-highlight.png" });

  await page.keyboard.press("PageUp");
  await expect.poll(() => rowIndex(rows)).toBe(0);

  for (let i = 0; i < Math.ceil(count / 10) + 1; i++) await page.keyboard.press("PageDown");
  await expect.poll(() => rowIndex(rows)).toBe(count - 1);
  await expectSelectedVisible(list, dialog.locator(".selected"));
  await page.keyboard.press("PageDown");
  await expect.poll(() => rowIndex(rows)).toBe(count - 1);
}

test.describe("palette page keys (#1419)", () => {
  test("command palette: PgDn/PgUp move 10 rows and clamp", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 10_000 });
    await page.keyboard.press("Control+Shift+p");
    const dialog = page.locator(".command-palette-dialog");
    await expect(dialog).toBeVisible();
    const rows = dialog.locator(".command-item");
    await exercise(page, dialog, rows, dialog.locator(".commands-container"));
  });

  test("quick open: PgDn/PgUp move 10 rows and clamp", async ({ page }) => {
    await page.goto("/?path=/perf/huge");
    await page.locator(".entry-item").first().waitFor({ timeout: 10_000 });
    await page.keyboard.press("Control+p");
    const dialog = page.locator(".quick-open-dialog");
    await dialog.locator(".search-input").fill("file");
    const rows = dialog.locator(".result-item");
    await expect(rows).toHaveCount(20);
    // Fewer than 21 rows: assert the contract directly for the 20-row cap.
    await expect.poll(() => rowIndex(rows)).toBe(0);
    await page.keyboard.press("PageDown");
    await expect.poll(() => rowIndex(rows)).toBe(10);
    await expectSelectedVisible(dialog.locator(".results-container"), dialog.locator(".selected"));
    await page.keyboard.press("PageDown");
    await expect.poll(() => rowIndex(rows)).toBe(19);
    await page.keyboard.press("PageDown");
    await expect.poll(() => rowIndex(rows)).toBe(19);
    await page.keyboard.press("PageUp");
    await expect.poll(() => rowIndex(rows)).toBe(9);
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await expect.poll(() => rowIndex(rows)).toBe(0);
  });
});
