/**
 * Special folder icons (#1491): a `src` (or `tests`, `node_modules`, ...)
 * folder paints its kind's glyph in every icon pack and view mode, while an
 * ordinary folder stays plain and a repository folder keeps its Git emblem.
 */
import { test, expect } from './fixtures';
import { decodePng } from './png-pixels';
import { waitForEntries, ALL_VIEW_MODES } from './helpers';

const root = '/special-folder-proof';
const folders = ['src', 'tests', 'docs', 'node_modules', '.github', 'images', 'scripts', 'public', 'dist', 'components', 'Downloads', 'Music', 'Folder', 'Repository'];
const files = ['README.md', 'package.json'];
const PACKS = ['classic', 'material', 'catppuccin', 'minimal'] as const;
type Page = import('@playwright/test').Page;

async function open(page: Page, iconTheme: string, viewMode: string) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(({ iconTheme, viewMode }) => {
    if (sessionStorage.getItem('special-folder-seeded')) return;
    localStorage.setItem('explorer-settings', JSON.stringify({ theme: 'dark', iconTheme, showHidden: true, thumbnailSize: 'medium', viewMode }));
    sessionStorage.setItem('special-folder-seeded', '1');
  }, { iconTheme, viewMode });
  await page.goto('/?path=/home/user');
  await waitForEntries(page);
  await page.evaluate(async ({ root, folders, files }) => {
    const url = '/src/lib/api/mock-fixtures.ts';
    const { mockFiles } = await import(/* @vite-ignore */ url);
    const entry = (name: string, kind: string) => ({ name, path: `${root}/${name}`, kind, size: kind === 'file' ? 120 : 0, modified: '2026-11-01T00:00:00Z', ...(name === 'Repository' ? { is_git_repo: true } : {}) });
    mockFiles[root] = [...folders.map((n) => entry(n, 'directory')), ...files.map((n) => entry(n, 'file'))];
    for (const n of folders) mockFiles[`${root}/${n}`] ??= [];
  }, { root, folders, files });
  await page.keyboard.press('Control+l');
  await page.locator('.path-input').fill(root);
  await page.locator('.path-input').press('Enter');
  await expect(row(page, 'src')).toBeVisible();
}

const row = (page: Page, name: string) => page.locator(`.entry-item[data-path="${root}/${name}"]:visible`);
const icon = (page: Page, name: string, pack: string) => row(page, name).locator(`[data-icon-theme="${pack}"]`).first();

/** Fraction of pixels that differ noticeably between two same-sized icon captures. */
async function pixelDifference(page: Page, a: string, b: string, pack: string) {
  const [pa, pb] = [decodePng(await icon(page, a, pack).screenshot({ scale: 'css' })), decodePng(await icon(page, b, pack).screenshot({ scale: 'css' }))];
  expect([pa.width, pa.height]).toEqual([pb.width, pb.height]);
  let differing = 0;
  for (let y = 0; y < pa.height; y++) for (let x = 0; x < pa.width; x++) {
    const [p, q] = [pa.pixel(x, y), pb.pixel(x, y)];
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60) differing++;
  }
  return differing / (pa.width * pa.height);
}

for (const mode of ALL_VIEW_MODES) {
  test(`${mode}: src paints its special icon in every pack; ordinary and repository folders keep theirs`, async ({ page }) => {
    await open(page, 'classic', mode);
    for (const pack of PACKS) {
      await page.keyboard.press('Control+,');
      const settings = page.locator('.settings-dialog');
      await expect(settings).toBeVisible();
      await settings.locator('.icon-theme-select').selectOption(pack);
      await page.keyboard.press('Escape');
      await expect(settings).toBeHidden();

      await expect(icon(page, 'src', pack).locator('[data-special-folder="src"]')).toHaveCount(1);
      await expect(icon(page, 'node_modules', pack).locator('[data-special-folder="node"]')).toHaveCount(1);
      await expect(icon(page, 'Folder', pack).locator('[data-special-folder]')).toHaveCount(0);
      await expect(icon(page, 'Repository', pack).locator('[data-special-folder]')).toHaveCount(0);
      await expect(icon(page, 'Repository', pack).locator('.git-repo-emblem')).toHaveCount(1);
      // The glyph actually paints: a src icon differs visibly from a plain folder.
      await expect.poll(() => pixelDifference(page, 'src', 'Folder', pack), { message: `${pack} ${mode}` }).toBeGreaterThan(mode === 'tiles' ? 0.04 : 0.02);

      // Selection keeps the special icon.
      await row(page, 'src').click();
      await expect(row(page, 'src')).toHaveClass(/selected/);
      await expect(icon(page, 'src', pack).locator('[data-special-folder="src"]')).toHaveCount(1);
      if (mode === 'tiles') await page.screenshot({ path: `screenshots/feat/special-folder-icons/${pack}-tiles.png`, animations: 'disabled' });
      else if (pack !== 'minimal') await page.screenshot({ path: `screenshots/feat/special-folder-icons/${pack}-${mode}.png`, animations: 'disabled' });
    }
  });
}
