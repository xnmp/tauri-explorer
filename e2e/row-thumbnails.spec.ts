/**
 * Thumbnails in Details and List rows (#1465).
 *
 * The opt-in "Thumbnails in Details and List" setting replaces each rendered
 * row's 16px icon with a 48px image/video thumbnail (the shared thumbnail
 * load/cache path) and grows every row to one fixed height: 58px Details
 * rows, 62px List slots. These tests turn it on through Settings and assert
 * decoded thumbnails, the icon fallback for other entries, row geometry and
 * keyboard/column behavior in Details, column-flow List and classic List.
 */

import { test, expect, type Page } from "./fixtures";
import { switchViewMode } from "./helpers";

const SHOTS = "screenshots/feat/thumbnails-in-list-and-detail-view";

async function openPictures(page: Page, settings: Record<string, unknown> = {}) {
  await page.goto("/?path=/home/user/Pictures");
  await page.evaluate((s) => {
    localStorage.clear();
    localStorage.setItem("explorer-settings", JSON.stringify(s));
  }, settings);
  await page.reload();
  await page.locator(".entry-item:visible").first().waitFor({ timeout: 10000 });
}

async function setRowThumbnails(page: Page, on: boolean) {
  await page.keyboard.press("Control+,");
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const row = dialog.locator(".setting-row").filter({
    has: page.locator(".setting-label", { hasText: /^Thumbnails in Details and List$/ }),
  });
  await row.scrollIntoViewIfNeeded();
  const toggle = row.locator('input[type="checkbox"]');
  if ((await toggle.isChecked()) !== on) await row.locator(".toggle").click();
  await expect(toggle).toBeChecked({ checked: on });
  await dialog.locator(".close-btn").click();
  await expect(dialog).toBeHidden();
}

const entry = (page: Page, name: string) =>
  page.locator(`.entry-item:visible[data-path="/home/user/Pictures/${name}"]`);

/** A row's thumbnail decoded a real image at the 48px box size. */
async function expectDecodedThumbnail(page: Page, name: string) {
  const thumb = entry(page, name).locator('.row-thumbnail[data-row-thumbnail="image"]');
  const full = thumb.locator("img.thumbnail-full");
  await expect(full).toHaveAttribute("src", /^(blob:|data:image)/, { timeout: 5000 });
  await expect.poll(() => full.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const box = await thumb.boundingBox();
  expect(box?.width).toBeCloseTo(48, 0);
  expect(box?.height).toBeCloseTo(48, 0);
}

async function height(page: Page, selector: string) {
  return (await page.locator(selector).first().boundingBox())!.height;
}

test.describe("Row thumbnails (#1465)", () => {
  test("Details rows show thumbnails at a fixed 58px row height, and turning it off restores 32px", async ({ page }) => {
    await openPictures(page);
    await expect(entry(page, "photo1.jpg").locator(".row-thumbnail")).toHaveCount(0);
    expect(await height(page, ".details-view .file-item:visible")).toBeCloseTo(32, 0);

    await setRowThumbnails(page, true);
    for (const name of ["photo1.jpg", "photo2.jpg", "screenshot.png"]) await expectDecodedThumbnail(page, name);
    // A folder keeps its (enlarged) icon instead of requesting a thumbnail.
    await expect(entry(page, "vacation").locator('.row-thumbnail[data-row-thumbnail="icon"] svg')).toBeVisible();

    // Every row is the same, taller height, and the virtual rows are laid out
    // on that pitch, so cursor/marquee math (index × height) stays exact.
    const rows = page.locator(".details-view .file-item:visible");
    const tops: number[] = [];
    for (let i = 0; i < 4; i++) {
      const box = (await rows.nth(i).boundingBox())!;
      expect(box.height).toBeCloseTo(58, 0);
      tops.push(box.y);
    }
    tops.sort((a, b) => a - b);
    for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeCloseTo(58, 0);

    // Columns stay aligned with the header: the Date cell sits under its header.
    const header = (await page.locator(".details-view .column-header.date-column:visible").boundingBox())!;
    const dateCell = (await entry(page, "photo1.jpg").locator("[data-cell='date']").boundingBox())!;
    expect(Math.abs(dateCell.x - header.x)).toBeLessThan(20);

    // The keyboard cursor still moves one row at a time.
    await entry(page, "photo1.jpg").click();
    await page.keyboard.press("ArrowDown");
    await expect(entry(page, "photo2.jpg")).toHaveClass(/selected/);

    await page.screenshot({ path: `${SHOTS}/details-thumbnails.png` });

    await setRowThumbnails(page, false);
    await expect(entry(page, "photo1.jpg").locator(".row-thumbnail")).toHaveCount(0);
    expect(await height(page, ".details-view .file-item:visible")).toBeCloseTo(32, 0);
  });

  test("column-flow List (Folder Peek) shows thumbnails in 62px slots", async ({ page }) => {
    await openPictures(page);
    await switchViewMode(page, "list");
    expect(await height(page, ".list-view .list-place:visible")).toBeCloseTo(30, 0);

    await setRowThumbnails(page, true);
    await expectDecodedThumbnail(page, "photo1.jpg");
    await expectDecodedThumbnail(page, "screenshot.png");
    const places = page.locator(".list-view .list-place:visible");
    const tops = (await Promise.all([0, 1, 2, 3].map(async (i) => (await places.nth(i).boundingBox())!))).map((b) => {
      expect(b.height).toBeCloseTo(62, 0);
      return b.y;
    }).sort((a, b) => a - b);
    for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeCloseTo(62, 0);
    expect((await entry(page, "photo1.jpg").boundingBox())!.height).toBeCloseTo(58, 0);

    await entry(page, "photo1.jpg").click();
    await page.keyboard.press("ArrowDown");
    await expect(entry(page, "photo2.jpg")).toHaveClass(/selected/);

    await page.screenshot({ path: `${SHOTS}/list-thumbnails.png` });
  });

  test("classic List (Folder Peek off) shows thumbnails on a 62px row pitch", async ({ page }) => {
    await openPictures(page, { folderPeek: false, viewMode: "list", listViewColumns: 1, rowThumbnails: true });
    await expect(page.locator(".list-view .list-item:visible").first()).toBeVisible();
    await expectDecodedThumbnail(page, "photo1.jpg");
    const items = page.locator(".list-view .list-item:visible");
    const tops = (await Promise.all([0, 1, 2, 3].map(async (i) => (await items.nth(i).boundingBox())!))).map((b) => {
      expect(b.height).toBeCloseTo(58, 0);
      return b.y;
    }).sort((a, b) => a - b);
    for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeCloseTo(62, 0);
  });
});
