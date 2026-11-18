import { test, expect, type Page } from './fixtures';
import { BUILT_IN_THEMES, pressShortcut, seedSettings, VIEW_MODES, waitForEntries } from './helpers';
import { expectSeededGrowth, steppedFrames, steppedFramesOfNewTab, type TabFrame } from './tab-frames';

const PATHS = ['/home/user', '/home/user/Downloads', '/home/user/Documents', '/home/user/Pictures', '/home/user/Documents/project/src', '/home/user/my-project/src'];
const SHOTS = 'screenshots/feat/tab-overflow';

async function openTabs(page: Page, count: number, width = 1000, viewMode = 'details', settings: Record<string, unknown> = {}) {
  await page.setViewportSize({ width, height: 720 });
  await seedSettings(page, { viewMode, showWindowControls: true, tabTitleGitRoot: false, ...settings });
  await page.addInitScript(({ count, paths }) => {
    localStorage.setItem('explorer-tabs', JSON.stringify({
      version: 3,
      tabs: Array.from({ length: count }, (_, i) => ({
        id: `overflow-${i}`, kind: 'explorer', activePaneId: `overflow-pane-${i}`,
        layout: { type: 'leaf', id: `overflow-pane-${i}`, path: paths[i % paths.length] },
      })),
      activeTabId: `overflow-${count - 1}`,
    }));
  }, { count, paths: PATHS });
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(count);
  await waitForEntries(page);
}

async function expectActiveVisible(page: Page) {
  await expect.poll(() => page.locator('.tab.active').evaluate(el => {
    const tab = el.getBoundingClientRect();
    const viewport = el.closest('.tab-viewport')!.getBoundingClientRect();
    return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
  })).toBe(true);
}

for (const mode of VIEW_MODES) test(`crowded tabs compress to icons with readable active tab and reachable controls (${mode})`, async ({ page }) => {
  await openTabs(page, 18, 1000, mode);
  // Also serves as the pre-fix reproduction: controls and the active tab used
  // to extend beyond the window while the strip hid its scrollbar.
  await page.screenshot({ path: `${SHOTS}/compression-${mode}.png`, animations: 'disabled' });
  await expect(page.getByRole('button', { name: 'New tab', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Search open tabs', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toBeInViewport();
  await expectActiveVisible(page);
  const inactive = page.locator('.tab:not(.active)').first();
  expect((await inactive.boundingBox())!.width).toBeLessThan(64);
  expect((await page.locator('.tab.active').boundingBox())!.width).toBeGreaterThanOrEqual(120);
  await expect(inactive.locator('.tab-title')).toBeHidden();
  await expect(inactive).toHaveAccessibleName(/\/home\/user/);
  await expect(page.locator('.tab.active .tab-cwd')).toBeVisible();
});

test('extreme overflow reveals shortcut, new and surviving tabs after resize and zoom', async ({ page }) => {
  await openTabs(page, 100, 680);
  await expectActiveVisible(page);
  await page.keyboard.press('Control+Tab');
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-0');
  await expectActiveVisible(page);
  await page.keyboard.press('Control+Shift+Tab');
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-99');
  await expectActiveVisible(page);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(page.locator('.tab')).toHaveCount(101);
  await expectActiveVisible(page);
  await page.keyboard.press('Control+w');
  await expect(page.locator('.tab')).toHaveCount(100);
  await expectActiveVisible(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await expectActiveVisible(page);
  await expect(page.getByRole('button', { name: 'New tab', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Search open tabs', exact: true })).toBeInViewport();
  await page.evaluate(() => { document.documentElement.style.zoom = '125%'; document.documentElement.style.setProperty('--app-zoom', '1.25'); });
  await expectActiveVisible(page);
  await page.screenshot({ path: `${SHOTS}/extreme-narrow.png`, animations: 'disabled' });
});

test('tab search distinguishes duplicate names by path and activates an offscreen folder', async ({ page }) => {
  await openTabs(page, 30, 680);
  const pickerButton = page.getByRole('button', { name: 'Search open tabs', exact: true });
  await pickerButton.click();
  const search = page.getByRole('combobox', { name: 'Search open tabs' });
  await expect(search).toBeFocused();
  await search.fill('my-project src');
  await expect(page.getByRole('option')).toHaveCount(5);
  await expect(page.getByRole('option').first()).toContainText('/home/user/my-project/src');
  await page.screenshot({ path: `${SHOTS}/tab-search.png`, animations: 'disabled' });
  await search.press('Enter');
  await expect(search).toBeHidden();
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-5');
  await expectActiveVisible(page);
  await expect(page.locator('.pane-tree:not(.retained) .entry-item').filter({ hasText: 'index.ts' }).first()).toBeVisible();
  await pickerButton.click();
  await search.fill('no-such-open-folder');
  await expect(page.getByText('No matching tabs')).toBeVisible();
  await search.press('Escape');
  await expect(search).toBeHidden();
  await expect(pickerButton).toBeFocused();
});

test('scroll arrows and wheel browse tabs without changing selection', async ({ page }) => {
  await openTabs(page, 30, 680);
  const scroller = page.locator('.tab-viewport');
  const initial = await scroller.evaluate(el => el.scrollLeft);
  await page.getByRole('button', { name: 'Scroll tabs left', exact: true }).click();
  await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeLessThan(initial);
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-29');
  await scroller.hover();
  const beforeWheel = await scroller.evaluate(el => el.scrollLeft);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeLessThan(beforeWheel);
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-29');
  // Picking the current tab must reveal it too: its ID does not change.
  await page.getByRole('button', { name: 'Search open tabs', exact: true }).click();
  await page.locator('.tab-search-result.current').click();
  await expectActiveVisible(page);
});

test('edge dragging reaches distant tabs and releases all scrolling on drop or Escape', async ({ page }) => {
  await openTabs(page, 30, 680);
  const scroller = page.locator('.tab-viewport');
  const ids = () => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('data-tab-id')));
  const before = await ids();
  const dragToEdge = async (inset = 2, travel = 120) => {
    await scroller.evaluate(el => { el.scrollLeft = 0; });
    const source = (await page.locator('.tab').first().boundingBox())!;
    const view = (await scroller.boundingBox())!;
    const point = { x: view.x + view.width - inset, y: source.y + source.height / 2 };
    await page.mouse.move(source.x + source.width / 2, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 6 });
    await expect(page.locator('.tab-drag-ghost')).toBeVisible();
    await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(travel);
    return point;
  };
  const point = await dragToEdge();
  // The strip shows the insertion position live (#1749): tabs it passed
  // move aside, so the tab under the pointer is no longer the target.
  // Leave the edge zone so scrolling stops, then drop where the strip settled.
  // Waiting for the exact scroll end is engine-dependent: WebKit counts the
  // shifted tabs' transforms in scrollWidth while they transition.
  const view = (await scroller.boundingBox())!;
  await page.mouse.move(view.x + view.width / 2, point.y, { steps: 3 });
  let settled = -1;
  await expect.poll(async () => {
    const now = await scroller.evaluate(el => el.scrollLeft);
    const stable = now === settled;
    settled = now;
    return stable;
  }, { intervals: [250] }).toBe(true);
  expect(settled).toBeGreaterThan(120);
  const targetIndex = Number(await page.locator('.tab-list').getAttribute('data-reorder-to'));
  expect(targetIndex).toBeGreaterThan(0);
  await page.mouse.up();
  const expected = [...before.slice(1)]; expected.splice(targetIndex, 0, before[0]);
  await expect.poll(ids).toEqual(expected);
  await expect(page.locator('.tab-drag-ghost')).toHaveCount(0);
  const afterDrop = await scroller.evaluate(el => el.scrollLeft);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await scroller.evaluate(el => el.scrollLeft)).toBe(afterDrop);

  const orderBeforeCancel = await ids();
  await dragToEdge();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.tab-drag-ghost')).toHaveCount(0);
  const afterCancel = await scroller.evaluate(el => el.scrollLeft);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await scroller.evaluate(el => el.scrollLeft)).toBe(afterCancel);
  expect(await ids()).toEqual(orderBeforeCancel);
  // Even a subpixel-per-frame velocity must accumulate into visible travel.
  await dragToEdge(23, 3);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await ids()).toEqual(orderBeforeCancel);
});

test('picker supports arrow selection, pointer dismissal and zoomed narrow placement', async ({ page }) => {
  await openTabs(page, 30, 680);
  const trigger = page.getByRole('button', { name: 'Search open tabs', exact: true });
  await trigger.click();
  const search = page.getByRole('combobox', { name: 'Search open tabs' });
  await expect(search).toBeFocused();
  await trigger.click();
  await expect(search).toBeHidden();
  await trigger.click();
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-1');
  await expect(page.locator('.pane-tree:not(.retained) .entry-item').filter({ hasText: 'installer.exe' }).first()).toBeVisible();
  await trigger.click();
  await search.fill('missing');
  await page.locator('.pane-tree:not(.retained) .file-list').click({ position: { x: 40, y: 120 } });
  await expect(search).toBeHidden();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => { document.documentElement.style.zoom = '150%'; document.documentElement.style.setProperty('--app-zoom', '1.5'); });
  await trigger.click();
  await expect(search).toBeFocused();
  const menu = await page.locator('.window-tab-picker').boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(321);
  expect((await page.locator('.tab.active .tab-cwd').boundingBox())!.width).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/picker-zoomed-narrow.png`, animations: 'disabled' });
});

for (const theme of BUILT_IN_THEMES) test(`compression and tab search remain usable in ${theme}`, async ({ page }) => {
  await seedSettings(page, { theme });
  await openTabs(page, 18);
  await expectActiveVisible(page);
  await page.getByRole('button', { name: 'Search open tabs', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search open tabs' });
  await search.fill('Downloads');
  await search.press('Enter');
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-1');
  await expect(page.locator('.pane-tree:not(.retained) .entry-item').filter({ hasText: 'installer.exe' }).first()).toBeVisible();
  await expectActiveVisible(page);
});

/** Both fillets of the active tab lie inside the strip's clip (#1734). */
async function expectFilletsUnclipped(page: Page) {
  await expect.poll(() => page.locator('.tab.active').evaluate(el => {
    const viewport = el.closest('.tab-viewport')!.getBoundingClientRect();
    return [...el.querySelectorAll('[data-region="tab-fillet"]')].map(fillet => {
      const box = fillet.getBoundingClientRect();
      return box.width > 1 && box.left >= viewport.left - 0.5 && box.right <= viewport.right + 0.5;
    });
  })).toEqual([true, true]);
}

for (const [label, count, width] of [['fitting', 3, 1000], ['overflowing', 40, 680]] as const) {
  test(`first and last tabs keep both fillets in a ${label} strip`, async ({ page }) => {
    await openTabs(page, count, width);
    await expectFilletsUnclipped(page);
    await page.keyboard.press('Control+Tab');
    await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', 'overflow-0');
    await expectActiveVisible(page);
    await expectFilletsUnclipped(page);
    await page.keyboard.press('Control+Shift+Tab');
    await expect(page.locator('.tab.active')).toHaveAttribute('data-tab-id', `overflow-${count - 1}`);
    await expectActiveVisible(page);
    await expectFilletsUnclipped(page);
  });
}

test('a new tab opens from a small seed to its full width with no jump', async ({ page }) => {
  await openTabs(page, 3);
  await page.waitForTimeout(300);
  expectSeededGrowth(await steppedFramesOfNewTab(page, () => pressShortcut(page, 't', { ctrlKey: true })));
});

/**
 * The new-tab button keeps its distance from the last tab in every frame,
 * and travels one way only: it never dips back before reaching its place.
 */
function expectPlusFollows(frames: TabFrame[]) {
  const steady = frames[0];
  const gap = steady.plusLeft! - steady.lastRight!;
  expect(gap).toBeGreaterThanOrEqual(0);
  const direction = Math.sign(frames[frames.length - 1].plusLeft! - steady.plusLeft!);
  let previous = steady.plusLeft!;
  for (const frame of frames) {
    expect(Math.abs(frame.plusLeft! - frame.lastRight! - gap), `t=${frame.t}`).toBeLessThanOrEqual(1);
    if (direction) expect((frame.plusLeft! - previous) * direction, `+ reverses at t=${frame.t}`).toBeGreaterThanOrEqual(-1);
    else expect(Math.abs(frame.plusLeft! - steady.plusLeft!), `+ moves at t=${frame.t}`).toBeLessThanOrEqual(1);
    previous = frame.plusLeft!;
  }
}

for (const [label, count, settings] of [['3 tabs', 3, {}], ['12 tabs', 12, {}], ['3 tabs at 125%', 3, { zoomLevel: 125 }]] as const) test(`the new-tab button rides behind a tab sliding in and out (${label})`, async ({ page }) => {
  // Two slides of 23 stepped frames each: 21-26s on a WebKit CI container,
  // over the default budget on a loaded one (#1775).
  test.setTimeout(90_000);
  await openTabs(page, count, 1000, 'details', settings);
  await page.waitForTimeout(300);
  const opening = await steppedFrames(page, () => pressShortcut(page, 't', { ctrlKey: true }));
  await expect(page.locator('.tab')).toHaveCount(count + 1);
  expect(opening.some(frame => frame.widths.length === count + 1)).toBe(true);
  expectPlusFollows(opening);

  await page.waitForTimeout(200);
  // Close by keyboard: a click would leave the pointer over the shrinking
  // strip, where it ends up hovering (and rotating) the new-tab button.
  const closing = await steppedFrames(page, () => pressShortcut(page, 'w', { ctrlKey: true, shiftKey: true }));
  await expect(page.locator('.tab')).toHaveCount(count);
  expectPlusFollows(closing);
});

// Crossing from a fitting strip into an overflowing one moves no tab by
// layout: the scroll buttons overlay the strip's ends instead of entering
// its flow, and the viewport keeps its geometry. (Only the strip's own
// scroll position may move the tabs, to reveal the new one; a reveal that
// follows a sliding tab glides, holding the list back by a transform.)
test('a strip crossing into overflow shifts no tab', async ({ page }) => {
  // Several stepped openings until one crosses: budget for a loaded runner.
  test.setTimeout(90_000);
  await openTabs(page, 14, 900);
  await page.waitForTimeout(300);
  let crossed = false;
  for (let i = 0; i < 20 && !crossed; i++) {
    // The crossing is a layout change: it lands in the first frames.
    const frames = await steppedFrames(page, () => pressShortcut(page, 't', { ctrlKey: true }), { steps: 10 });
    crossed = frames.some(frame => frame.overflowing);
    for (let index = 1; index < frames.length; index++) {
      const [a, b] = [frames[index - 1], frames[index]];
      const shift = (b.firstLeft! + b.scrollLeft - b.listShift) - (a.firstLeft! + a.scrollLeft - a.listShift);
      expect(Math.abs(shift), `first tab shifts ${shift.toFixed(1)}px at t=${b.t} (overflowing ${a.overflowing} -> ${b.overflowing})`).toBeLessThanOrEqual(1);
    }
    await page.waitForTimeout(250);
  }
  expect(crossed).toBe(true);
  await expect(page.getByRole('button', { name: 'Scroll tabs left', exact: true })).toBeVisible();
});
