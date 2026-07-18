/**
 * E2E tests for folder preview thumbnails (issue #146).
 *
 * At large/XL tile sizes, folders containing images show photos composited
 * into the folder glyph; smaller sizes and imageless folders keep the plain
 * folder icon. The mock backend runs the real domain selection rules over
 * the mock filesystem, so these tests assert actual selection outcomes.
 */

import { test, expect, type Page } from "./fixtures";

async function waitForFileList(page: Page) {
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 10000 });
}

async function switchToTilesView(page: Page) {
  await page.keyboard.press("Escape");

  const content = page.locator(".file-list .content").first();
  const box = await content.boundingBox();
  const clickY = box ? Math.round(box.height / 2) : 300;
  await content.click({ button: "right", position: { x: 10, y: clickY } });

  const contextMenu = page.locator(".context-menu");
  await contextMenu.waitFor({ state: "visible", timeout: 2000 });
  await contextMenu.locator('.menu-item:has-text("Tiles")').click();
  await page.locator(".tiles-view .entry-item").first().waitFor({ timeout: 3000 });
}

async function setThumbnailSize(page: Page, size: "small" | "medium" | "large" | "xlarge") {
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
}

/** The tile (ItemButton) for a given entry name in tiles view. */
function tileFor(page: Page, name: string) {
  return page.locator(".tiles-view .entry-item").filter({ hasText: name }).first();
}

test.describe("Folder preview thumbnails", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
    await switchToTilesView(page);
  });

  test("folder with images shows composited photo previews at Large size", async ({ page }) => {
    await setThumbnailSize(page, "large");

    // "vacation" contains beach.jpg + sunset.png in the mock fs — its tile
    // must composite the folder glyph with actual photo thumbnails.
    const vacation = tileFor(page, "vacation");
    const folderThumb = vacation.locator(".folder-thumb");
    await expect(folderThumb).toBeVisible({ timeout: 5000 });

    // Two images selected → front photo + one back photo, each a real
    // ThumbnailImage that resolves to an <img> with a blob/data URL.
    const photos = folderThumb.locator(".photo");
    await expect(photos).toHaveCount(2);
    const frontImg = folderThumb.locator(".front-photo img").first();
    await expect(frontImg).toBeVisible({ timeout: 5000 });
    const src = await frontImg.getAttribute("src");
    expect(src).toMatch(/^(blob:|data:image)/);

    // The folder glyph layers frame the photos (back panel + front flap).
    await expect(folderThumb.locator("svg.folder-layer")).toHaveCount(2);
  });

  test("imageless folder keeps the plain folder icon at Large size", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForFileList(page);
    await switchToTilesView(page);
    await setThumbnailSize(page, "large");

    // Documents contains no images directly (only a subfolder + docs), so its
    // tile must fall back to the plain FileIcon inside the mounted preview.
    const documents = tileFor(page, "Documents");
    await expect(documents.locator(".folder-thumb")).toBeVisible({ timeout: 5000 });
    await expect(documents.locator(".folder-thumb .photo")).toHaveCount(0);
    await expect(documents.locator(".folder-thumb svg")).toHaveCount(1); // the FileIcon

    // Pictures HAS images directly — same view must show its photos, proving
    // the fallback above is a per-folder outcome, not a global miss.
    const pictures = tileFor(page, "Pictures");
    await expect(pictures.locator(".folder-thumb .photo").first()).toBeVisible({ timeout: 5000 });
  });

  test("preview folder glyph is the same size as a plain folder icon", async ({ page }) => {
    // Regression for #148: the preview-mode folder glyph (.folder-layer) was
    // matched by the tile-icon scale rule and blown up ~2x, so folders WITH a
    // preview rendered visibly larger than plain ones. Both must render the
    // folder silhouette at the same on-screen size.
    await page.goto("/?path=/home/user");
    await waitForFileList(page);
    await switchToTilesView(page);
    await setThumbnailSize(page, "large");

    // Pictures has images → composited folder glyph (svg.folder-layer).
    const preview = tileFor(page, "Pictures").locator("svg.folder-layer").first();
    await expect(preview).toBeVisible({ timeout: 5000 });
    // Documents is imageless → plain FileIcon folder glyph inside the mount.
    const plain = tileFor(page, "Documents").locator(".folder-thumb svg").first();
    await expect(plain).toBeVisible({ timeout: 5000 });

    const previewBox = await preview.boundingBox();
    const plainBox = await plain.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(plainBox).not.toBeNull();

    // The rendered glyph boxes must match within a few px (identical viewBox &
    // element size). Pre-fix the preview glyph was ~2x the plain one.
    expect(Math.abs(previewBox!.height - plainBox!.height)).toBeLessThan(4);
    expect(Math.abs(previewBox!.width - plainBox!.width)).toBeLessThan(4);
  });

  test("small and medium tile sizes never render folder previews", async ({ page }) => {
    for (const size of ["small", "medium"] as const) {
      await setThumbnailSize(page, size);
      const vacation = tileFor(page, "vacation");
      await expect(vacation).toBeVisible();
      await expect(vacation.locator(".folder-thumb")).toHaveCount(0);
    }

    // Sanity: bumping to xlarge in the same session enables previews.
    await setThumbnailSize(page, "xlarge");
    await expect(
      tileFor(page, "vacation").locator(".folder-thumb .photo").first()
    ).toBeVisible({ timeout: 5000 });
  });
});
