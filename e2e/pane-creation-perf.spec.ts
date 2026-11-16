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
    await page.keyboard.press('Control+End');
    expect(await page.evaluate(() => document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion).length)).toBe(0);
    await expect(source.locator('.entry-item[data-index="4999"]')).toBeVisible();
    await expect(source.locator('.entry-item[data-index="4999"]')).toBeInViewport();
    await expect(source.locator('.entry-item[data-index="4999"]')).toHaveClass(/selected/);
  });

  for (const modified of [false, true]) {
    test(`a held ${mode} file press keeps its target until the ${modified ? 'Ctrl-click' : 'click'} completes`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto(`/?path=/perf/huge-5000&viewMode=${mode}`);
      await page.locator('.entry-item').first().waitFor();
      // Let the initial ResizeObserver delivery initialize List's virtualized viewport before freezing it.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const press = await page.evaluate(async () => {
        // @ts-expect-error Vite serves the application module.
        const { windowTabsManager: manager } = await import('/src/lib/state/window-tabs.svelte.ts');
        // @ts-expect-error Vite serves the browser runtime.
        const { tick } = await import('/node_modules/svelte/src/index-client.js');
        const sourceId = manager.activePaneId;
        manager.splitPane('right');
        await tick();
        const panes = document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion);
        panes.forEach(a => { a.pause(); a.currentTime = 55; });
        // The reveal's first rendering starts the source's entry reflow inside
        // ResizeObserver delivery (#1718); a later observer on the same probe
        // runs right after it. A real press pauses both; freeze both to aim.
        const probe = document.querySelector(`.explorer-pane[data-pane-id="${sourceId}"] .layout-probe`)!;
        const reflows = await new Promise<Animation[]>(resolve => {
          const observer = new ResizeObserver(() => {
            observer.disconnect();
            const started = document.getAnimations().filter(a => a.id === 'entry-reflow');
            started.forEach(a => { a.pause(); a.currentTime = 55; });
            resolve(started);
          });
          observer.observe(probe);
        });
        const animations = [...panes, ...reflows];
        await Promise.all(animations.map(a => a.ready));
        const source = document.querySelector<HTMLElement>(`.explorer-pane[data-pane-id="${sourceId}"]`)!;
        const rect = source.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width * .57);
        // Press a genuinely visible row beyond the source's final split edge.
        // Settling between down/up would hand this point to the new pane.
        for (const row of source.querySelectorAll<HTMLElement>('.entry-item')) {
          if (row.getAttribute('aria-selected') === 'true') continue;
          const box = row.getBoundingClientRect();
          // WebKit truncates native input coordinates; validate the actual
          // integer point, safely below a tile's separate peek control.
          const y = Math.floor(box.bottom - Math.min(8, box.height / 3));
          if (x <= box.left || x >= box.right || y < 90 || y > innerHeight - 50) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit?.closest('.entry-item') !== row || hit.closest('button, input, a')) continue;
          (window as any).__heldPressAnimations = animations;
          return { sourceId, x, y, path: row.dataset.path!, width: rect.width };
        }
        throw new Error('No visible file press beyond the final pane boundary');
      });
      await page.mouse.move(press.x, press.y);
      await page.evaluate(() => (window as any).__heldPressAnimations.forEach((a: Animation) => a.play()));
      await page.mouse.down();
      if (modified) await page.keyboard.down('Control');
      // Deliberately outlast the natural 220 ms finish while the button is held.
      await page.waitForTimeout(300);
      const source = page.locator(`.explorer-pane[data-pane-id="${press.sourceId}"]`);
      expect((await source.boundingBox())!.width).toBeCloseTo(press.width, 0);
      await page.mouse.up();
      if (modified) await page.keyboard.up('Control');
      await expect(source.locator(`.entry-item[data-path="${press.path}"]`).first()).toHaveAttribute('aria-selected', 'true');
      await expect(source).toHaveClass(/\bactive\b/);
      await expect.poll(async () => (await source.boundingBox())!.width).toBeLessThan(press.width * .6);
      expect(await page.evaluate(() => document.getAnimations().filter(a => ((a.effect as KeyframeEffect)?.target as HTMLElement)?.dataset?.paneMotion).length)).toBe(0);
    });
  }

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
