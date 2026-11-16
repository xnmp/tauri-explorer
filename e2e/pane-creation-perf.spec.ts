import { test, expect } from './fixtures';

for (const mode of ['details', 'list', 'tiles']) {
  for (const placement of ['right', 'down'] as const) {
    test(`${placement} pane reveal keeps the live ${mode} view at a stable layout until settling`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto(`/?path=/perf/huge-5000&viewMode=${mode}`);
      await page.locator('.entry-item').first().waitFor();
      const result = await page.evaluate(async placement => {
        // @ts-expect-error Vite serves the application module.
        const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
        // @ts-expect-error Vite serves the browser runtime.
        const { tick } = await import('/node_modules/svelte/src/index-client.js');
        const source = document.querySelector<HTMLElement>('.explorer-pane')!;
        const content = source.querySelector<HTMLElement>('.file-list > .content')!;
        const initialWidth = content.getBoundingClientRect().width;
        const initialHeight = content.getBoundingClientRect().height;
        const widths: number[] = [];
        const heights: number[] = [];
        const delivered: number[] = [];
        const observer = new ResizeObserver(([entry]) => delivered.push(entry.contentRect.width));
        observer.observe(content);
        const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await paint();
        delivered.length = 0;
        manager.splitPane(placement);
        await tick();
        const animations = document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion);
        animations.forEach(a => { a.pause(); a.currentTime = 0; });
        await Promise.all(animations.map(a => a.ready));
        for (const time of [0, 30, 60, 90, 120, 150, 180, 210]) {
          animations.forEach(a => { a.currentTime = time; });
          await paint();
          widths.push(content.getBoundingClientRect().width);
          heights.push(content.getBoundingClientRect().height);
        }
        const duringDeliveries = delivered.length;
        animations.forEach(a => a.finish());
        await paint();
        const finalWidth = content.getBoundingClientRect().width;
        const finalHeight = content.getBoundingClientRect().height;
        observer.disconnect();
        return { initialWidth, initialHeight, widths, heights, duringDeliveries, finalWidth, finalHeight, totalDeliveries: delivered.length,
          sameContent: source.querySelector('.file-list > .content') === content,
          animationCount: animations.length, mountedRows: document.querySelectorAll('.entry-item').length };
      }, placement);
      expect(result.animationCount).toBeGreaterThanOrEqual(3);
      expect(result.sameContent).toBe(true);
      expect(result.widths.every(width => Math.abs(width - result.initialWidth) < 1)).toBe(true);
      expect(result.heights.every(height => Math.abs(height - result.initialHeight) < 1)).toBe(true);
      expect(result.duringDeliveries).toBe(0);
      expect(result.totalDeliveries).toBeLessThanOrEqual(1);
      expect(placement === 'right' ? result.finalWidth : result.finalHeight).toBeLessThan((placement === 'right' ? result.initialWidth : result.initialHeight) * .6);
      expect(result.mountedRows).toBeLessThan(1000);
    });
  }

  test(`activating the surviving ${mode} pane settles its viewport before keyboard navigation`, async ({ page }) => {
    await page.goto(`/?path=/perf/huge-5000&viewMode=${mode}`);
    await page.locator('.entry-item').first().waitFor();
    const sourceId = await page.evaluate(async () => {
      // @ts-expect-error Vite serves the application module.
      const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
      // @ts-expect-error Vite serves the browser runtime.
      const { tick } = await import('/node_modules/svelte/src/index-client.js');
      const id = manager.activePaneId;
      manager.splitPane('right');
      await tick();
      const animations = document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion);
      animations.forEach(a => { a.pause(); a.currentTime = 80; });
      await Promise.all(animations.map(a => a.ready));
      return id;
    });
    const source = page.locator(`.explorer-pane[data-pane-id="${sourceId}"]`);
    // Click the visible name, not a wide Details row whose center can lie
    // beyond the reveal clip and belong to the new pane underneath it.
    await source.getByText('folder-00000', { exact: true }).click();
    await expect(source).toHaveClass(/\bactive\b/);
    expect(await page.evaluate(() => document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion).length)).toBe(0);
    await page.keyboard.press('Control+End');
    await expect(source.locator('.entry-item[data-index="4999"]')).toBeVisible();
    await expect(source.locator('.entry-item[data-index="4999"]')).toBeInViewport();
    await expect(source.locator('.entry-item[data-index="4999"]')).toHaveClass(/selected/);
  });

  test(`capture stable ${mode} pane reveal`, async ({ page }) => {
    test.skip(!process.env.CAPTURE_EVIDENCE, 'Opt-in visual acceptance evidence');
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`/?path=/perf/huge-5000&viewMode=${mode}`);
    await page.locator('.entry-item').first().waitFor();
    const directory = 'screenshots/fix/pane-motion-perf';
    await page.screenshot({ path: `${directory}/${mode}-before.png` });
    await page.evaluate(async () => {
      // @ts-expect-error Vite serves the application module.
      const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
      // @ts-expect-error Vite serves the browser runtime.
      const { tick } = await import('/node_modules/svelte/src/index-client.js');
      manager.splitPane('right');
      await tick();
      const animations = document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion);
      animations.forEach(a => { a.pause(); a.currentTime = 80; });
      await Promise.all(animations.map(a => a.ready));
      (window as any).__perfEvidenceAnimations = animations;
    });
    await page.screenshot({ path: `${directory}/${mode}-during.png` });
    await page.evaluate(async () => {
      const animations = (window as any).__perfEvidenceAnimations as Animation[];
      const finished = animations.map(a => a.finished.catch(() => {}));
      animations.forEach(a => a.finish());
      await Promise.all(finished);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.screenshot({ path: `${directory}/${mode}-after.png` });
  });
}
