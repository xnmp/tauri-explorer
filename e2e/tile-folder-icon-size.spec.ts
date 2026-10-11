/**
 * Tiles view icon sizing across presets (#1049).
 *
 * TileSurface scales every 64px icon SVG by `tileLayout(size).iconScale` so it
 * fills the tile's icon slot. At the Small preset the slot (48px) is narrower
 * than the source SVG (64px); a bare `<svg>` flex child used to be shrunk to
 * the slot width BEFORE the scale, so plain folders drew at 36px while the
 * wrapped git-repo folder (and every file icon) drew at the intended 48px.
 * These tests measure what the user sees: the rendered bounding box of each
 * tile's icon graphic after the tile scale, in CSS px.
 */
import { test, expect, type Page } from "./fixtures";
import { switchViewMode, waitForEntries, HOME_URL } from "./helpers";
import { THUMBNAIL_SIZE_CONFIG, type ThumbnailSize } from "../src/lib/domain/tile-layout";

const PLAIN_FOLDER = "/home/user/Documents";
const GIT_FOLDER = "/home/user/my-project";
const DOCUMENT_FILE = "/home/user/readme.txt";

// 2x so the committed evidence screenshots stay legible at 48px icons.
test.use({ deviceScaleFactor: 2, viewport: { width: 1100, height: 720 } });

interface Box { x: number; y: number; w: number; h: number }
interface IconMeasure { slot: Box; icon: Box }

async function setThumbnailSize(page: Page, size: ThumbnailSize) {
  await page.keyboard.press("Control+,");
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const row = dialog.locator(".setting-row").filter({
    has: page.locator(".setting-label", { hasText: /^Thumbnail Size$/ }),
  });
  await row.scrollIntoViewIfNeeded();
  await row.locator("select").selectOption(size);
  await dialog.locator(".close-btn").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".tile-surface")).toHaveCSS("--tile-icon-size", `${THUMBNAIL_SIZE_CONFIG[size].displaySize}px`);
}

/** Rendered box of a tile's icon slot and of the icon graphic inside it. */
async function measureIcon(page: Page, path: string): Promise<IconMeasure> {
  const slot = page.locator(`.tiles-view .entry-item[data-path="${path}"] .tile-icon`);
  await expect(slot).toBeVisible();
  return slot.evaluate((element) => {
    const graphic = element.querySelector(
      ":scope > svg, :scope > .icon-cat, :scope > .nf-icon-badge, " +
      ":scope > .folder-thumb > svg, :scope > .folder-thumb > .icon-cat, :scope > .folder-thumb > .nf-icon-badge",
    );
    if (!graphic) throw new Error("tile has no icon graphic");
    const toBox = (r: DOMRect) => ({ x: r.x, y: r.y, w: Math.round(r.width), h: Math.round(r.height) });
    return { slot: toBox(element.getBoundingClientRect()), icon: toBox(graphic.getBoundingClientRect()) };
  });
}

async function openTilesHome(page: Page) {
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitForEntries(page);
  await switchViewMode(page, "tiles");
}

test.describe("Tiles view folder icon size", () => {
  test("Small preset: plain and git-repo folders both render at the 48px icon size", async ({ page }) => {
    await openTilesHome(page);
    await setThumbnailSize(page, "small");
    const size = THUMBNAIL_SIZE_CONFIG.small.displaySize;

    const plain = await measureIcon(page, PLAIN_FOLDER);
    const git = await measureIcon(page, GIT_FOLDER);

    expect(plain.icon).toMatchObject({ w: size, h: size });
    expect(git.icon).toMatchObject({ w: size, h: size });
    expect(git.icon.w).toBe(plain.icon.w);
    expect(git.icon.h).toBe(plain.icon.h);
    await page.screenshot({ path: "evidence/ac-1-small-plain-and-git-folders-48px.png" });
  });

  for (const preset of ["medium", "large", "xlarge"] as const) {
    test(`${preset} preset: folder, git-repo folder and file icons all render at the preset size`, async ({ page }) => {
      await openTilesHome(page);
      await setThumbnailSize(page, preset);
      const size = THUMBNAIL_SIZE_CONFIG[preset].displaySize;

      for (const path of [PLAIN_FOLDER, GIT_FOLDER, DOCUMENT_FILE]) {
        const measured = await measureIcon(page, path);
        expect(measured.icon, path).toMatchObject({ w: size, h: size });
      }
      if (preset === "large") {
        await page.screenshot({ path: "evidence/ac-2-large-preset-icons-96px.png" });
      }
    });
  }

  test("Small preset: the git badge stays in the folder's lower-right corner", async ({ page }) => {
    await openTilesHome(page);
    await setThumbnailSize(page, "small");

    const folder = await measureIcon(page, GIT_FOLDER);
    const badge = page.locator(`.tiles-view .entry-item[data-path="${GIT_FOLDER}"] circle.git-repo-badge`);
    await expect(badge).toBeVisible();
    const badgeBox = await badge.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    const centerX = folder.icon.x + folder.icon.w / 2;
    const centerY = folder.icon.y + folder.icon.h / 2;
    // Entirely inside the folder's rendered box (not clipped) ...
    expect(badgeBox.x).toBeGreaterThanOrEqual(folder.icon.x);
    expect(badgeBox.y).toBeGreaterThanOrEqual(folder.icon.y);
    expect(badgeBox.x + badgeBox.w).toBeLessThanOrEqual(folder.icon.x + folder.icon.w + 0.5);
    expect(badgeBox.y + badgeBox.h).toBeLessThanOrEqual(folder.icon.y + folder.icon.h + 0.5);
    // ... and in its lower-right quadrant.
    expect(badgeBox.x).toBeGreaterThan(centerX);
    expect(badgeBox.y).toBeGreaterThan(centerY);
    // Scaled with the folder: 9.25/48 of the folder's edge, i.e. ~18.5px at 48px.
    const expectedDiameter = (2 * 9.25 / 48) * folder.icon.w;
    expect(badgeBox.w).toBeCloseTo(expectedDiameter, 0);

    const tile = page.locator(`.tiles-view .entry-item[data-path="${GIT_FOLDER}"]`);
    await tile.screenshot({ path: "evidence/ac-3-small-git-badge-anchored.png" });
  });

  test("the tile icon slot measures the preset size at every preset", async ({ page }) => {
    await openTilesHome(page);
    for (const preset of ["small", "medium", "large", "xlarge"] as const) {
      await setThumbnailSize(page, preset);
      const size = THUMBNAIL_SIZE_CONFIG[preset].displaySize;
      for (const path of [PLAIN_FOLDER, GIT_FOLDER, DOCUMENT_FILE]) {
        const measured = await measureIcon(page, path);
        expect(measured.slot, `${preset} ${path}`).toMatchObject({ w: size, h: size });
      }
      if (preset === "small") {
        await page.screenshot({ path: "evidence/ac-4-small-tile-slots-unchanged.png" });
      }
    }
  });

  test("Small preset: the inline New folder tile renders its folder at 48px", async ({ page }) => {
    await openTilesHome(page);
    await setThumbnailSize(page, "small");
    const size = THUMBNAIL_SIZE_CONFIG.small.displaySize;

    // Right-click genuinely empty space below the last tile (same approach as
    // switchViewMode) so the background menu with "New folder" opens.
    const content = page.locator(".file-list .content").first();
    const box = await content.boundingBox();
    const lastBox = await page.locator(".entry-item").last().boundingBox();
    if (!box || !lastBox) throw new Error("tiles view not laid out");
    const clickY = Math.min(Math.round(lastBox.y + lastBox.height - box.y) + 12, Math.round(box.height) - 8);
    await content.click({ button: "right", position: { x: 10, y: clickY } });
    await page.getByText("New folder", { exact: true }).click();
    await expect(page.locator(".new-folder-input")).toBeVisible();

    const editorIcon = page.locator(".tile-inline-new-folder .tile-icon");
    await expect(editorIcon).toBeVisible();
    const measured = await editorIcon.evaluate((element) => {
      const svg = element.querySelector(":scope > svg");
      if (!svg) throw new Error("new-folder tile has no icon svg");
      const r = svg.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    expect(measured).toEqual({ w: size, h: size });
    await page.screenshot({ path: "evidence/ac-5-small-inline-new-folder-48px.png" });
  });
});
