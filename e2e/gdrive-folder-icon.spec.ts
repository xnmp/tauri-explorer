/**
 * Google Drive folder icon (#1551): a GVfs Google Drive mount root and the
 * common local mount names (`Google Drive`, `gdrive`, `My Drive`) carry the
 * tri-colour drive badge in every view mode, while other GVfs mounts and
 * ordinary folders stay plain.
 */
import { test, expect } from './fixtures';
import { decodePng } from './png-pixels';
import { waitForEntries, ALL_VIEW_MODES } from './helpers';

const gvfs = '/run/user/1000/gvfs';
const gdriveRoot = `${gvfs}/google-drive:host=gmail.com,user=someone`;
const sftpRoot = `${gvfs}/sftp:host=example.com`;
const named = '/gdrive-folder-proof';
const namedFolders = ['Google Drive', 'gdrive', 'My Drive', 'Folder'];
type Page = import('@playwright/test').Page;

async function open(page: Page, viewMode: string, iconTheme = 'classic') {
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.addInitScript(({ iconTheme, viewMode }) => {
    if (sessionStorage.getItem('gdrive-folder-seeded')) return;
    localStorage.setItem('explorer-settings', JSON.stringify({ theme: 'dark', iconTheme, thumbnailSize: 'medium', viewMode }));
    sessionStorage.setItem('gdrive-folder-seeded', '1');
  }, { iconTheme, viewMode });
  await page.goto(`/?path=${encodeURIComponent(gvfs)}`);
  await waitForEntries(page);
  await page.evaluate(async ({ named, namedFolders }) => {
    const url = '/src/lib/api/mock-fixtures.ts';
    const { mockFiles } = await import(/* @vite-ignore */ url);
    mockFiles[named] = namedFolders.map((name: string) => ({ name, path: `${named}/${name}`, kind: 'directory', size: 0, modified: '2026-11-01T00:00:00Z' }));
    for (const name of namedFolders) mockFiles[`${named}/${name}`] ??= [];
  }, { named, namedFolders });
}

async function navigate(page: Page, path: string) {
  await page.keyboard.press('Control+l');
  await page.locator('.path-input').fill(path);
  await page.locator('.path-input').press('Enter');
}

const row = (page: Page, path: string) => page.locator(`.entry-item[data-path="${path}"]:visible`);
const badge = (page: Page, path: string) => row(page, path).locator('[data-special-folder="gdrive"]');

/** Fraction of pixels that differ noticeably between two same-sized icon captures. */
async function pixelDifference(page: Page, a: string, b: string) {
  const shot = async (path: string) => decodePng(await row(page, path).locator('.folder-icon').first().screenshot({ scale: 'css' }));
  const [pa, pb] = [await shot(a), await shot(b)];
  expect([pa.width, pa.height]).toEqual([pb.width, pb.height]);
  let differing = 0;
  for (let y = 0; y < pa.height; y++) for (let x = 0; x < pa.width; x++) {
    const [p, q] = [pa.pixel(x, y), pb.pixel(x, y)];
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60) differing++;
  }
  return differing / (pa.width * pa.height);
}

for (const mode of ALL_VIEW_MODES) {
  test(`${mode}: Google Drive mount roots and named Drive folders paint the drive badge`, async ({ page }) => {
    await open(page, mode);

    // GVfs: only the google-drive: mount root is badged.
    await expect(row(page, gdriveRoot)).toBeVisible();
    await expect(badge(page, gdriveRoot)).toHaveCount(1);
    await expect(row(page, sftpRoot).locator('[data-special-folder]')).toHaveCount(0);
    // The badge actually paints: the Drive root differs visibly from the plain sftp root.
    await expect.poll(() => pixelDifference(page, gdriveRoot, sftpRoot)).toBeGreaterThan(mode === 'tiles' ? 0.04 : 0.02);
    // Each of the three strokes takes its own palette colour.
    const glyph = badge(page, gdriveRoot).locator('use.special-folder-glyph');
    const slots = await glyph.evaluate((el) => ['a', 'b', 'c'].map((s) => getComputedStyle(el).getPropertyValue(`--special-folder-glyph-${s}`).trim()));
    expect(new Set(slots).size).toBe(3);
    await page.screenshot({ path: `screenshots/feat/add-special-icon-folder-for-gdrive/gvfs-${mode}.png`, animations: 'disabled' });

    // Local mount names.
    await navigate(page, named);
    await expect(row(page, `${named}/Google Drive`)).toBeVisible();
    for (const name of ['Google Drive', 'gdrive', 'My Drive']) await expect(badge(page, `${named}/${name}`), name).toHaveCount(1);
    await expect(row(page, `${named}/Folder`).locator('[data-special-folder]')).toHaveCount(0);
    await page.screenshot({ path: `screenshots/feat/add-special-icon-folder-for-gdrive/named-${mode}.png`, animations: 'disabled' });
  });
}

test('Google Drive badge in the Material, Catppuccin and Minimal packs', async ({ page }) => {
  await open(page, 'tiles', 'material');
  for (const pack of ['material', 'catppuccin', 'minimal'] as const) {
    if (pack !== 'material') {
      await page.keyboard.press('Control+,');
      const settings = page.locator('.settings-dialog');
      await expect(settings).toBeVisible();
      await settings.locator('.icon-theme-select').selectOption(pack);
      await page.keyboard.press('Escape');
      await expect(settings).toBeHidden();
    }
    await expect(row(page, gdriveRoot).locator(`[data-icon-theme="${pack}"]`).first().locator('[data-special-folder="gdrive"]')).toHaveCount(1);
    await expect(row(page, sftpRoot).locator('[data-special-folder]')).toHaveCount(0);
    await page.screenshot({ path: `screenshots/feat/add-special-icon-folder-for-gdrive/gvfs-tiles-${pack}.png`, animations: 'disabled' });
  }
});
