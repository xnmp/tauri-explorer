/**
 * Special folder badges (#1527): a `src` folder keeps the theme's ordinary
 * folder colour in every pack and view mode, and its kind is a small badge in
 * the icon's bottom-left corner, clear of the Folder Peek caret and the Git
 * status letter.
 */
import { test, expect } from './fixtures';
import { decodePng } from './png-pixels';
import { waitForEntries, ALL_VIEW_MODES } from './helpers';

type Page = import('@playwright/test').Page;
type Box = { x: number; y: number; width: number; height: number };

const root = '/home/user/Documents/project';
const PACKS = ['classic', 'material', 'catppuccin'] as const;
const pane = (page: Page) => page.locator('.pane-tree:not(.retained) .explorer-pane');
const row = (page: Page, name: string) => pane(page).locator(`.entry-item[data-path="${root}/${name}"]:visible`);
const icon = (page: Page, name: string) => row(page, name).locator('[data-icon-theme]').first();

async function open(page: Page, theme: string, viewMode: string) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(({ theme, viewMode }) => {
    if (sessionStorage.getItem('special-folder-badges-seeded')) return;
    localStorage.setItem('explorer-settings', JSON.stringify({ theme, viewMode, iconTheme: 'default', showGitStatus: true, folderPeek: true, folderPeekCarets: true, thumbnailSize: 'medium' }));
    sessionStorage.setItem('special-folder-badges-seeded', '1');
  }, { theme, viewMode });
  await page.goto('/?path=/home/user');
  await waitForEntries(page);
  await page.evaluate(async (root) => {
    const { mockFiles } = await import(/* @vite-ignore */ '/src/lib/api/mock-fixtures.ts');
    // An ordinary folder beside the project's special ones, for comparison.
    if (!mockFiles[root].some((e: { name: string }) => e.name === 'Folder')) {
      mockFiles[root].push({ name: 'Folder', path: `${root}/Folder`, kind: 'directory', size: 0, modified: '2026-11-01T00:00:00Z' });
    }
    // Non-empty: an empty folder's icon is ghosted.
    mockFiles[`${root}/Folder`] ??= [{ name: 'a.txt', path: `${root}/Folder/a.txt`, kind: 'file', size: 1, modified: '2026-11-01T00:00:00Z' }];
    const { windowTabsManager } = await import(/* @vite-ignore */ '/src/lib/state/window-tabs.svelte.ts');
    await windowTabsManager.getActiveExplorer()!.navigateTo(root, { autoEnterSingleSubdir: false });
  }, root);
  await expect(row(page, 'src')).toBeVisible();
  await expect(row(page, 'Folder')).toBeVisible();
  await page.mouse.move(0, 0);
}

const setPack = (page: Page, iconTheme: string) => page.evaluate(async (iconTheme) => {
  const { settingsStore } = await import(/* @vite-ignore */ '/src/lib/state/settings.svelte.ts');
  settingsStore.update({ iconTheme });
}, iconTheme);

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Fraction of pixels outside `exclude` (icon-relative) with no close match
 * within 1px in the other icon's capture. The neighbourhood absorbs the
 * sub-pixel offset between two tiles' antialiased edges.
 */
async function bodyDifference(page: Page, exclude: Box) {
  const [a, b] = [decodePng(await icon(page, 'src').screenshot({ scale: 'css' })), decodePng(await icon(page, 'Folder').screenshot({ scale: 'css' }))];
  const [w, h] = [Math.min(a.width, b.width), Math.min(a.height, b.height)];
  const close = (p: number[], q: number[]) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) <= 60;
  let differing = 0, counted = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // The margin covers antialiasing and Classic's large drop shadow under the badge.
    if (x >= exclude.x - 4 && x <= exclude.x + exclude.width + 4 && y >= exclude.y - 4 && y <= exclude.y + exclude.height + 4) continue;
    counted++;
    const p = a.pixel(x, y);
    let matched = false;
    for (let dy = -1; dy <= 1 && !matched; dy++) for (let dx = -1; dx <= 1 && !matched; dx++) {
      const [qx, qy] = [x + dx, y + dy];
      if (qx >= 0 && qy >= 0 && qx < w && qy < h && close(p, b.pixel(qx, qy))) matched = true;
    }
    if (!matched) differing++;
  }
  return differing / counted;
}

for (const mode of ALL_VIEW_MODES) {
  test(`${mode}: a src folder keeps the plain folder colour and badges its kind bottom-left`, async ({ page }) => {
    await open(page, 'dark', mode);
    for (const pack of PACKS) {
      await setPack(page, pack);
      await expect(row(page, 'src').locator(`[data-icon-theme="${pack}"]`)).toHaveCount(1);
      const badge = icon(page, 'src').locator('.special-folder-badge[data-special-folder="src"]');
      await expect(badge).toHaveCount(1);
      await expect(icon(page, 'Folder').locator('[data-special-folder]')).toHaveCount(0);

      const iconBox = (await icon(page, 'src').boundingBox())!;
      const badgeBox = (await badge.boundingBox())!;
      expect(badgeBox.width, `${pack} ${mode} badge size`).toBeGreaterThanOrEqual(mode === 'tiles' ? 20 : 7);
      // Bottom-left quadrant of the icon.
      expect(badgeBox.x + badgeBox.width / 2, `${pack} ${mode}`).toBeLessThan(iconBox.x + iconBox.width / 2);
      expect(badgeBox.y + badgeBox.height / 2, `${pack} ${mode}`).toBeGreaterThan(iconBox.y + iconBox.height / 2);

      // Never under the peek caret or the Git status letter.
      const caret = row(page, 'src').locator('.peek-caret:visible');
      await expect(caret).toHaveCount(1);
      expect(intersects(badgeBox, (await caret.boundingBox())!), `${pack} ${mode} caret`).toBe(false);
      const git = row(page, 'src').locator('.git-indicator');
      await expect(git).toBeVisible();
      expect(intersects(badgeBox, (await git.boundingBox())!), `${pack} ${mode} git status`).toBe(false);

      // Outside the badge the icon is pixel-identical to an ordinary folder.
      const local = { x: badgeBox.x - iconBox.x, y: badgeBox.y - iconBox.y, width: badgeBox.width, height: badgeBox.height };
      await expect.poll(() => bodyDifference(page, local), { message: `${pack} ${mode} body` }).toBeLessThan(0.01);
      if (mode === 'tiles') await page.screenshot({ path: `screenshots/feat/special-folder-badges/${pack}-pack-tiles.png`, animations: 'disabled' });
    }
  });
}

for (const theme of ['light', 'dark', 'hacker'] as const) for (const mode of ['tiles', 'details'] as const) {
  test(`${theme} ${mode}: badge evidence`, async ({ page }) => {
    await open(page, theme, mode);
    await expect(icon(page, 'src').locator('.special-folder-badge')).toHaveCount(1);
    await page.screenshot({ path: `screenshots/feat/special-folder-badges/${theme}-${mode}.png`, animations: 'disabled' });
  });
}
