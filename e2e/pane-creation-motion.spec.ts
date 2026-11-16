import { test, expect, type Page } from './fixtures';

async function freezeSplit(page: Page, placement: 'left' | 'right' | 'up' | 'down') {
  return page.evaluate(async placement => {
    // @ts-expect-error Vite serves the application module.
    const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
    // @ts-expect-error Vite serves Svelte's browser runtime.
    const { tick } = await import('/node_modules/svelte/src/index-client.js');
    const sourceId = manager.activePaneId;
    manager.splitPane(placement);
    await tick();
    const animations = document.getAnimations().filter(animation => (animation.effect as KeyframeEffect)?.target instanceof HTMLElement
      && ((animation.effect as KeyframeEffect).target as HTMLElement).dataset.paneMotion);
    for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
    await Promise.all(animations.map(animation => animation.ready));
    (window as any).__splitAnimations = animations;
    return { sourceId, paneId: manager.activePaneId, count: animations.length };
  }, placement);
}

async function seek(page: Page, time: number) {
  await page.evaluate(time => {
    for (const animation of (window as any).__splitAnimations as Animation[]) animation.currentTime = time;
  }, time);
}

const frame = (page: Page, id: string) => page.locator(`.pane-frame[data-pane-motion="pane:${id}"]`);

const modes = process.env.ALL_VIEW_MODES ? ['details', 'list', 'tiles'] : ['list'];
for (const mode of modes) {
  test(`splitting preserves the existing pane, selection and scroll (${mode})`, async ({ page }) => {
    await page.goto(`/?path=/perf/huge-5000&viewMode=${mode}`);
    await page.locator('.entry-item').first().waitFor();
    await page.locator('.virtual-viewport').evaluate(el => { el.scrollTop = 12_000; });
    await page.locator('.entry-item').nth(3).click();
    const before = await page.evaluate(async () => {
      // @ts-expect-error Vite serves the application module.
      const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
      const pane = document.querySelector<HTMLElement>('.explorer-pane')!;
      const viewport = pane.querySelector<HTMLElement>('.virtual-viewport')!;
      const selected = pane.querySelector<HTMLElement>('.entry-item.selected')!.dataset.path;
      (window as any).__paneContinuity = { pane, viewport };
      const before = { id: pane.dataset.paneId!, selected, scroll: viewport.scrollTop };
      manager.splitPane('right');
      return before;
    });
    const original = page.locator(`.explorer-pane[data-pane-id="${before.id}"]`);
    await expect(page.locator('.explorer-pane')).toHaveCount(2);
    expect(await original.evaluate(el => el === (window as any).__paneContinuity.pane)).toBe(true);
    expect(await original.locator('.virtual-viewport').evaluate(el => el === (window as any).__paneContinuity.viewport)).toBe(true);
    expect(await original.locator('.virtual-viewport').evaluate(el => el.scrollTop)).toBe(before.scroll);
    // Tiles can put the selected item outside the retained scroll viewport
    // when columns change. The selection contract is independent of that.
    expect(await page.evaluate(async id => {
      // @ts-expect-error Vite serves the application module.
      const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
      return manager.getExplorer(id).getSelectedEntries().map((entry: { path: string }) => entry.path);
    }, before.id)).toEqual([before.selected]);
    await expect(page.locator('.explorer-pane.active')).not.toHaveAttribute('data-pane-id', before.id);
  });
}

for (const placement of ['left', 'right', 'up', 'down'] as const) {
  test(`anchored reveal coordinates live pane bounds and divider when splitting ${placement}`, async ({ page }) => {
    await page.goto('/?path=/home/user/Pictures');
    await page.locator('.entry-item').first().waitFor();
    const before = (await page.locator('.explorer-pane').boundingBox())!;
    const split = await freezeSplit(page, placement);
    expect(split.count).toBeGreaterThanOrEqual(3);
    const original = frame(page, split.sourceId);
    const incoming = frame(page, split.paneId);
    const content = incoming.locator('.file-list');
    const start = (await original.boundingBox())!;
    expect(start.width).toBeCloseTo(before.width, 0);
    expect(start.height).toBeCloseTo(before.height, 0);
    const newContentBefore = (await content.boundingBox())!;
    await seek(page, 110);
    const middle = (await original.boundingBox())!;
    const newContentDuring = (await content.boundingBox())!;
    const divider = (await page.locator('.pane-divider').boundingBox())!;
    await seek(page, 220);
    const end = (await original.boundingBox())!;
    const horizontal = placement === 'left' || placement === 'right';
    const extent = (box: typeof start) => horizontal ? box.width : box.height;
    expect(extent(middle)).toBeLessThan(extent(start));
    expect(extent(middle)).toBeGreaterThan(extent(end));
    expect(newContentDuring.x).toBeCloseTo(newContentBefore.x, 1);
    expect(newContentDuring.y).toBeCloseTo(newContentBefore.y, 1);
    expect(newContentDuring.width).toBeCloseTo(newContentBefore.width, 1);
    const first = placement === 'left' || placement === 'up';
    const sourceEdge = horizontal ? (first ? middle.x : middle.x + middle.width) : (first ? middle.y : middle.y + middle.height);
    const dividerEdge = horizontal ? (first ? divider.x + divider.width : divider.x) : (first ? divider.y + divider.height : divider.y);
    expect(Math.abs(sourceEdge - dividerEdge)).toBeLessThan(1);
  });
}

test('nested creation preserves unrelated panes and interrupted splits close cleanly', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?path=/home/user/Pictures');
  await page.locator('.entry-item').first().waitFor();
  const first = await freezeSplit(page, 'right');
  await seek(page, 220);
  const unchanged = (await frame(page, first.sourceId).boundingBox())!;
  const second = await freezeSplit(page, 'down');
  await seek(page, 80);
  expect((await frame(page, first.sourceId).boundingBox())!).toEqual(unchanged);
  const third = await freezeSplit(page, 'left');
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the application module.
    const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
    manager.closePane();
  });
  await expect(page.locator('.explorer-pane')).toHaveCount(3);
  await expect(page.locator(`.explorer-pane[data-pane-id="${third.paneId}"]`)).toHaveCount(0);
  await expect(frame(page, second.paneId)).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion).length)).toBe(0);
  expect(errors).toEqual([]);
});

test('reduced motion creates an immediately usable pane without an entrance', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?path=/home/user/Pictures');
  await page.locator('.entry-item').first().waitFor();
  const split = await freezeSplit(page, 'right');
  expect(split.count).toBe(0);
  const incoming = page.locator(`.explorer-pane[data-pane-id="${split.paneId}"]`);
  await incoming.locator('.entry-item[data-path="/home/user/Pictures/vacation"]').dblclick();
  await expect(incoming.locator('.entry-item[data-path="/home/user/Pictures/vacation/beach.jpg"]')).toBeVisible();
});

test('a nested entrance cannot paint or receive input ahead of its opening ancestor', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/?path=/home/user/Pictures');
  await page.locator('.entry-item').first().waitFor();
  await freezeSplit(page, 'right');
  await seek(page, 55);
  const split = await freezeSplit(page, 'down');
  await seek(page, 22);
  const overlap = await page.evaluate(id => {
    const incoming = document.querySelector<HTMLElement>(`.pane-frame[data-pane-motion="pane:${id}"]`)!;
    const box = incoming.getBoundingClientRect();
    const boundary = document.querySelector('.pane-divider')!.getBoundingClientRect();
    const clip = getComputedStyle(incoming).clipPath.match(/[\d.]+/g)!.map(Number);
    const x = (box.left + boundary.left) / 2;
    const y = box.bottom - 35;
    return { inset: clip[3], opening: boundary.right - box.left,
      hitsIncoming: document.elementFromPoint(x, y)?.closest('.pane-frame') === incoming };
  }, split.paneId);
  expect(overlap.inset).toBeGreaterThan(0);
  expect(overlap.inset).toBeCloseTo(overlap.opening, 0);
  expect(overlap.hitsIncoming).toBe(false);
});

test('deep restored splits keep their last pane sized and reachable', async ({ page }) => {
  await page.goto('/?path=/home/user');
  await page.locator('.entry-item').first().waitFor();
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the application module.
    const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
    let layout: any = { type: 'leaf', id: 'deep-11', path: '/home/user' };
    for (let i = 10; i >= 0; i--) layout = { type: 'split', id: `deep-split-${i}`, direction: 'row', ratio: .5,
      first: { type: 'leaf', id: `deep-${i}`, path: '/home/user' }, second: layout };
    manager.restoreFromState({ version: 3, activeTabId: 'deep', tabs: [{ kind: 'explorer', id: 'deep', activePaneId: 'deep-11', layout }] });
  });
  await expect(page.locator('.explorer-pane')).toHaveCount(12);
  const last = page.locator('.explorer-pane[data-pane-id="deep-11"]');
  await expect(last.locator('.entry-item').filter({ hasText: 'Documents' }).first()).toBeVisible();
  expect((await last.boundingBox())!.width).toBeCloseTo(240, 0);
  const widths = await page.locator('.pane-frame').evaluateAll(frames => frames.map(frame => frame.getBoundingClientRect().width));
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(239);
  expect(await page.locator('.pane-container').evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
});

test('capture anchored reveal before, during and after creation', async ({ page }) => {
  test.skip(!process.env.CAPTURE_EVIDENCE, 'Opt-in visual acceptance evidence');
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/?path=/home/user/Pictures&viewMode=details');
  await page.locator('.entry-item[data-path="/home/user/Pictures/vacation"]').click();
  await page.screenshot({ path: 'screenshots/feat/pane-continuity/before.png' });
  await freezeSplit(page, 'right');
  await seek(page, 45);
  await page.screenshot({ path: 'screenshots/feat/pane-continuity/during.png' });
  await seek(page, 220);
  await page.screenshot({ path: 'screenshots/feat/pane-continuity/after.png' });
  await freezeSplit(page, 'down');
  await seek(page, 45);
  await page.screenshot({ path: 'screenshots/feat/pane-continuity/nested-during.png' });
});
