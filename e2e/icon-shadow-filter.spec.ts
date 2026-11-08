/**
 * No CSS filter on file or folder icons (#1532).
 *
 * `filter: drop-shadow(...)` on every built-in icon made WebKitGTK
 * re-rasterize each visible tile on every scroll frame (Tiles p95 ~105 ms vs
 * ~24 ms unfiltered on 1,596 tiles). Large built-in artwork now carries a
 * static offset copy (BakedShadow) instead. This guards every icon element in
 * every view mode and icon pack, and that the icons still paint.
 */
import { test, expect, type Page } from './fixtures';
import { waitForEntries, ALL_VIEW_MODES } from './helpers';

const root = '/icon-shadow-proof';
const names = ['App.tsx', 'main.js', 'lib.rs', 'index.html', 'notes.txt', 'files.zip', 'image.png', 'song.mp3', 'movie.mp4', 'app.exe', 'script.py', 'unknown.xyz', 'Folder', 'Repository'];
const packs = ['classic', 'material', 'catppuccin', 'minimal'] as const;

async function open(page: Page, theme: string, iconTheme: string, viewMode: string) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(({ theme, iconTheme, viewMode }) => {
    localStorage.setItem('explorer-settings', JSON.stringify({ theme, iconTheme, showHidden: true, thumbnailSize: 'medium', viewMode }));
  }, { theme, iconTheme, viewMode });
  await page.goto('/?path=/home/user');
  await waitForEntries(page);
  await page.evaluate(async ({ root, names }) => {
    const url = '/src/lib/api/mock-fixtures.ts';
    const { mockFiles } = await import(/* @vite-ignore */ url);
    mockFiles[root] = names.map((name: string) => ({ name, path: `${root}/${name}`, kind: ['Folder', 'Repository'].includes(name) ? 'directory' : 'file', size: 120, modified: '2026-10-17T00:00:00Z', ...(name === 'Repository' ? { is_git_repo: true } : {}) }));
    const control = ((window as unknown as { __mockControl?: Record<string, unknown> }).__mockControl ??= {});
    control.videoThumbnail = async () => { throw new Error('icon fixture has no thumbnails'); };
    control.imageThumbnail = async () => { throw new Error('icon fixture has no thumbnails'); };
  }, { root, names });
  await page.keyboard.press('Control+l');
  await page.locator('.path-input').fill(root);
  await page.locator('.path-input').press('Enter');
  await expect(page.locator(`.entry-item[data-path="${root}/${names[0]}"]:visible`)).toBeVisible();
}

/** Every element of every visible row's icon whose computed filter is not none. */
async function iconAudit(page: Page) {
  return page.evaluate((root) => {
    const rows = [...document.querySelectorAll<HTMLElement>(`.pane-tree:not(.retained) .entry-item[data-path^="${root}/"]`)];
    const filtered: string[] = [];
    let painted = 0;
    for (const row of rows) {
      // The view's icon slot: Details/List `[data-drag-icon]`, Tiles `.tile-icon`.
      const slot = row.querySelector<HTMLElement>('[data-drag-icon], .tile-icon');
      const icon = slot?.querySelector<HTMLElement>('.icon-cat, svg, img');
      if (!slot || !icon) continue;
      const box = icon.getBoundingClientRect();
      if (box.width >= 12 && box.height >= 12 && getComputedStyle(icon).visibility !== 'hidden') painted++;
      for (const el of [slot, ...slot.querySelectorAll('*')]) {
        const f = getComputedStyle(el).filter;
        if (f && f !== 'none') filtered.push(`${row.dataset.path}: <${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> ${f}`);
      }
      // Ancestors up to the row too: a filter on the icon slot costs the same.
      for (let el = slot.parentElement; el && el !== row.parentElement; el = el.parentElement) {
        const f = getComputedStyle(el).filter;
        if (f && f !== 'none') filtered.push(`${row.dataset.path}: ancestor <${el.tagName.toLowerCase()} class="${el.className}"> ${f}`);
      }
    }
    return { rows: rows.length, painted, filtered };
  }, root);
}

for (const mode of ALL_VIEW_MODES) {
  for (const pack of packs) {
    test(`${mode} / ${pack}: icons paint with no CSS filter`, async ({ page }) => {
      await open(page, 'dark', pack, mode);
      await expect.poll(async () => (await iconAudit(page)).painted).toBe(names.length);
      const audit = await iconAudit(page);
      expect(audit.rows).toBe(names.length);
      expect(audit.filtered, 'icons must not carry a per-frame CSS filter').toEqual([]);
    });
  }
}

test('Tiles bake a static shadow under built-in artwork; 16px rows draw none', async ({ page }) => {
  await open(page, 'light', 'classic', 'tiles');
  for (const name of ['notes.txt', 'Folder', 'App.tsx', 'index.html']) {
    const shadow = page.locator(`.entry-item[data-path="${root}/${name}"]:visible .baked-icon-shadow`);
    await expect(shadow, `${name} keeps a shadow`).toHaveCount(1);
    const style = await shadow.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, transform: el.getAttribute('transform') }));
    expect(Number(style.opacity)).toBeGreaterThan(0);
    expect(style.transform).toMatch(/translate\(0 [\d.]+\)/);
  }
  // The copy is drawn beneath the glyph: it precedes the real artwork.
  const order = await page.locator(`.entry-item[data-path="${root}/notes.txt"]:visible svg`).first()
    .evaluate((svg) => svg.firstElementChild?.classList.contains('baked-icon-shadow'));
  expect(order).toBe(true);

  await page.keyboard.press('Control+Shift+p');
  const palette = page.locator('.command-palette-dialog');
  await palette.locator('.search-input').fill('Details View');
  await palette.locator('.command-item').filter({ has: page.getByText('Details View', { exact: true }) }).click();
  await expect(palette).toBeHidden();
  await expect(page.locator(`.entry-item[data-path="${root}/notes.txt"]:visible svg`).first()).toBeVisible();
  // Glyphs shared across sizes keep the copy in markup but never display it at 16px.
  const rowShadows = await page.locator(`.pane-tree:not(.retained) .entry-item[data-path^="${root}/"] .baked-icon-shadow`)
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
  expect(rowShadows.every((display) => display === 'none')).toBe(true);
});

test('Tiles icon evidence (light + dark)', async ({ page }) => {
  test.skip(!process.env.CAPTURE_EVIDENCE, 'evidence only');
  const dir = process.env.ICON_SHADOW_SHOT_DIR ?? 'screenshots/perf/icon-shadow-filter';
  const label = process.env.ICON_SHADOW_SHOT_LABEL ?? 'after';
  for (const theme of ['light', 'dark']) {
    await open(page, theme, 'classic', 'tiles');
    await expect.poll(async () => (await iconAudit(page)).painted).toBe(names.length);
    await page.locator('.file-list:visible').first().screenshot({ path: `${dir}/${label}-tiles-${theme}.png`, animations: 'disabled' });
  }
});
