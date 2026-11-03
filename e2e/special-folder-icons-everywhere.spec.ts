/**
 * Special folder icons everywhere (#1499): beyond the file list (#1491), a
 * `src` (or `tests`, ...) folder paints its pack-native special icon in Miller
 * columns, sidebar bookmarks and recent rows, and the window tab bar, while
 * ordinary folders keep each surface's own art and a repository folder keeps
 * its Git styling (#1490).
 */
import { test, expect } from './fixtures';
import { waitForEntries } from './helpers';

const root = '/special-folder-proof';
const folders = ['src', 'tests', 'docs', 'node_modules', 'Folder', 'Repository'];
const PACKS = ['default', 'material', 'classic', 'catppuccin', 'minimal'] as const;
const SHOTS = 'screenshots/feat/special-folder-icons-everywhere';
type Page = import('@playwright/test').Page;

// 16px icons: evidence crops are captured at 2x so each glyph is legible.
test.use({ deviceScaleFactor: 2 });

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(({ root }) => {
    if (sessionStorage.getItem('special-everywhere-seeded')) return;
    localStorage.setItem('explorer-settings', JSON.stringify({ theme: 'dark', iconTheme: 'default', showHidden: true, millerLayers: 1, viewMode: 'details' }));
    localStorage.setItem('explorer-bookmarks', JSON.stringify([
      { name: 'src', path: `${root}/src`, icon: 'folder' },
      { name: 'Folder', path: `${root}/Folder`, icon: 'folder' },
    ]));
    // Recent locations that exist in the default mock tree (Recent prunes
    // missing paths shortly after startup).
    const now = Date.now();
    localStorage.setItem('explorer-frecency', JSON.stringify([
      { path: '/home/user/Documents/project/src', accesses: [now - 3_600_000, now] },
      { path: '/home/user/Documents/project', accesses: [now - 7_200_000] },
    ]));
    sessionStorage.setItem('special-everywhere-seeded', '1');
  }, { root });
  await page.goto('/?path=/home/user');
  await waitForEntries(page);
  await page.evaluate(async ({ root, folders }) => {
    const url = '/src/lib/api/mock-fixtures.ts';
    const { mockFiles } = await import(/* @vite-ignore */ url);
    const entry = (name: string) => ({ name, path: `${root}/${name}`, kind: 'directory', size: 0, modified: '2026-11-01T00:00:00Z', ...(name === 'Repository' ? { is_git_repo: true } : {}) });
    mockFiles[root] = folders.map(entry);
    for (const n of folders) mockFiles[`${root}/${n}`] = [{ name: 'notes.md', path: `${root}/${n}/notes.md`, kind: 'file', size: 10, modified: '2026-11-01T00:00:00Z' }];
  }, { root, folders });
}

async function go(page: Page, path: string) {
  await page.keyboard.press('Control+l');
  await page.locator('.path-input:visible').fill(path);
  await page.locator('.path-input:visible').press('Enter');
  await expect(page.locator(`.pane-tree:not(.retained) .entry-item[data-path="${path}/notes.md"]`)).toBeVisible();
}

async function usePack(page: Page, pack: string) {
  await page.keyboard.press('Control+,');
  const settings = page.locator('.settings-dialog');
  await expect(settings).toBeVisible();
  await settings.locator('.icon-theme-select').selectOption(pack);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
}

const millerRow = (page: Page, name: string) => page.locator(`.pane-tree:not(.retained) .col-entry[data-path="${root}/${name}"]`);
const bookmark = (page: Page, name: string) => page.locator(`.user-bookmark[data-path="${root}/${name}"]`);
const recent = (page: Page, path: string) => page.locator(`.recent-item[title="${path}"]`);
const tab = (page: Page, name: string) => page.locator('.tab').filter({ has: page.locator('.tab-cwd', { hasText: new RegExp(`^${name}$`) }) });

test('special folders take their pack-native icon in Miller columns, sidebar and tab bar', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  // The first tab stays on an ordinary folder, and a second tab (which shows
  // the strip) on src.
  await go(page, `${root}/Folder`);
  await page.keyboard.press('Control+t');
  await expect(page.locator('.tab')).toHaveCount(2);
  await go(page, `${root}/src`);
  await expect(page.locator('.miller-columns:visible')).toBeVisible();

  for (const pack of PACKS) {
    await usePack(page, pack);
    // `default` resolves to the colour theme's suggested pack.
    if (pack !== 'default') await expect(millerRow(page, 'Folder').locator(`[data-icon-theme="${pack}"]`)).toHaveCount(1);
    const theme = await millerRow(page, 'Folder').locator('[data-icon-theme]').first().getAttribute('data-icon-theme');

    // Miller columns: the parent column lists src (active), docs, tests...
    await expect(millerRow(page, 'src').locator(`[data-icon-theme="${theme}"] [data-special-folder="src"]`)).toHaveCount(1);
    await expect(millerRow(page, 'node_modules').locator('[data-special-folder="node"]')).toHaveCount(1);
    await expect(millerRow(page, 'Folder').locator('[data-special-folder]')).toHaveCount(0);
    await expect(millerRow(page, 'Repository').locator('[data-special-folder]')).toHaveCount(0);
    await expect(millerRow(page, 'Repository').locator('.git-repo-emblem')).toHaveCount(1);

    // Sidebar: a special bookmark and recent row use the pack icon; an
    // ordinary bookmark keeps the sidebar's own folder.
    await expect(bookmark(page, 'src').locator(`.nav-icon[data-region="sidebar-icon"] [data-icon-theme="${theme}"] [data-special-folder="src"]`)).toHaveCount(1);
    await expect(bookmark(page, 'Folder').locator('[data-special-folder]')).toHaveCount(0);
    await expect(bookmark(page, 'Folder').locator('svg.nav-icon')).toHaveCount(1);
    await expect(recent(page, '/home/user/Documents/project/src').locator('.nav-icon [data-special-folder="src"]')).toHaveCount(1);
    await expect(recent(page, '/home/user/Documents/project').locator('[data-special-folder]')).toHaveCount(0);
    await expect(recent(page, '/home/user/Documents/project').locator('svg.nav-icon')).toHaveCount(1);
    // Built-in Quick Access folders keep their bespoke glyphs.
    await expect(page.locator('.quick-access .folder-item:not(.user-bookmark) [data-special-folder]')).toHaveCount(0);

    // Tab bar: the src tab's icon is the special folder; the ordinary
    // folder's tab keeps the plain tab icon.
    await expect(tab(page, 'src').locator(`.tab-icon-special [data-icon-theme="${theme}"] [data-special-folder="src"]`)).toHaveCount(1);
    await expect(tab(page, 'Folder').locator('[data-special-folder]')).toHaveCount(0);
    await expect(tab(page, 'Folder').locator('svg.tab-icon')).toHaveCount(1);
    const box = await tab(page, 'src').locator('.tab-icon-special').boundingBox();
    expect(box && Math.round(box.width)).toBe(16);

    const sidebar = await page.locator('.files-view').boundingBox();
    const miller = await page.locator('.miller-columns:visible').boundingBox();
    const strip = await page.locator('[data-region="tab-strip"]').boundingBox();
    await page.screenshot({ path: `${SHOTS}/${pack}-window.png`, animations: 'disabled' });
    await page.screenshot({ path: `${SHOTS}/${pack}-sidebar.png`, animations: 'disabled', clip: { x: sidebar!.x, y: sidebar!.y, width: sidebar!.width, height: Math.min(sidebar!.height, 360) } });
    await page.screenshot({ path: `${SHOTS}/${pack}-miller.png`, animations: 'disabled', clip: { x: miller!.x, y: miller!.y, width: miller!.width, height: Math.min(miller!.height, 260) } });
    await page.screenshot({ path: `${SHOTS}/${pack}-tabs.png`, animations: 'disabled', clip: { x: strip!.x, y: strip!.y, width: Math.min(strip!.width, 420), height: strip!.height } });
  }
});

test('history menu shows a special folder icon for a visited special folder', async ({ page }) => {
  await open(page);
  await go(page, `${root}/src`);
  await go(page, `${root}/Folder`);
  await page.locator('.nav-btn[title^="Back"]:visible').first().click({ button: 'right' });
  const menu = page.locator('.history-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.history-item[title$="/src"] [data-special-folder="src"]')).toHaveCount(1);
  await expect(menu.locator('.history-item[title$="/Folder"] [data-special-folder]')).toHaveCount(0);
});
