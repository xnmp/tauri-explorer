import { expect, test, type Page } from "./fixtures";

let pageErrors: string[] = [];
test.beforeEach(({ page }) => { pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message)); });
test.afterEach(() => expect(pageErrors).toEqual([]));

type Node = { type: "leaf"; id: string; path: string } | {
  type: "split"; id: string; direction: "row" | "column"; ratio: number; first: Node; second: Node;
};
function layout(ids: number[], depth = 0): Node {
  if (ids.length === 1) return { type: "leaf", id: `viewport-${ids[0]}`, path: "/home/user/Documents" };
  const middle = Math.ceil(ids.length / 2);
  return { type: "split", id: `split-${ids.join("-")}`, direction: depth % 2 ? "column" : "row", ratio: 0.5,
    first: layout(ids.slice(0, middle), depth + 1), second: layout(ids.slice(middle), depth + 1) };
}
async function restore(page: Page, count = 16) {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor();
  const state = { version: 3, tabs: [{ id: "viewport-tab", kind: "explorer", activePaneId: `viewport-${count - 1}`,
    layout: layout(Array.from({ length: count }, (_, i) => i)) }], activeTabId: "viewport-tab" };
  await page.evaluate(async value => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    (await load()).windowTabsManager.restoreFromState(value);
  }, state);
  await expect(page.locator(".explorer-pane")).toHaveCount(count);
  return state;
}
async function focus(page: Page, id: string) {
  await page.evaluate(async paneId => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    (await load()).windowTabsManager.setActivePane(paneId);
  }, id);
}

test("dense restored layout reveals focused files and preserves saved layout", async ({ page }, info) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const saved = await restore(page);
  const files = page.locator('.explorer-pane.active .entry-item[data-path="/home/user/Documents/notes.md"]');
  await expect(files).toHaveCount(1);
  await expect(files).toBeInViewport();
  await files.click();
  await expect(files).toHaveClass(/selected/);
  await page.screenshot({ path: info.outputPath("dense-pane-viewport.png") });
  await focus(page, "viewport-0");
  await expect(files).toHaveCount(1);
  await expect(files).toBeInViewport();
  await files.click();
  await expect(files).toHaveClass(/selected/);
  const captured = await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    return (await load()).windowTabsManager.captureState();
  });
  expect(captured.tabs[0].layout).toEqual(saved.tabs[0].layout);
});

for (const viewMode of ["details", "list", "tiles"] as const) {
  test(`${viewMode} remains usable in a zoomed dense island workspace`, async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 640 });
    await restore(page);
    await page.evaluate(async mode => {
      const load = new Function("return Promise.all([import('/src/lib/state/window-tabs.svelte.ts'), import('/src/lib/state/settings.svelte.ts')])");
      const [{ windowTabsManager: manager }, { settingsStore }] = await load();
      settingsStore.update({ floatingIslands: true, zoomLevel: 150 });
      for (const explorer of manager.getAllExplorers()) explorer.setViewMode(mode);
    }, viewMode);
    await expect(page.locator("html")).toHaveAttribute("data-vibrancy", "");
    const entry = page.locator('.explorer-pane.active .entry-item[data-path="/home/user/Documents/project"]');
    await expect(entry).toBeInViewport();
    await entry.click();
    await expect(entry).toHaveClass(/selected/);
    await page.setViewportSize({ width: 1024, height: 768 });
    await focus(page, "viewport-0");
    await expect(entry).toBeInViewport();
    await entry.click();
    await expect(entry).toHaveClass(/selected/);
    expect(await page.evaluate(() => ({ top: window.scrollY, left: window.scrollX }))).toEqual({ top: 0, left: 0 });
  });
}

test("keyboard divider resizing changes pane geometry without moving file selection", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await restore(page, 2);
  const file = page.locator('.explorer-pane.active .entry-item[data-path="/home/user/Documents/notes.md"]');
  await file.click();
  const selection = () => page.locator(".explorer-pane").evaluateAll(panes => panes.map(pane =>
    [...pane.querySelectorAll(".entry-item.selected")].map(entry => entry.getAttribute("data-path"))));
  const selectedBefore = await selection();
  const divider = page.getByRole("separator", { name: "Resize panes" });
  await divider.focus();
  const first = page.locator(".explorer-pane").first();
  const before = (await first.boundingBox())!.width;
  const percent = Number(await divider.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await first.boundingBox())!.width).toBeGreaterThan(before + 10);
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeCloseTo(percent + 5, 1);
  await expect(file).toHaveClass(/selected/);
  expect(await selection()).toEqual(selectedBefore);
  await page.keyboard.press("Home");
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow")))
    .toBeCloseTo(Number(await divider.getAttribute("aria-valuemin")), 1);
  await page.keyboard.press("End");
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow")))
    .toBeCloseTo(Number(await divider.getAttribute("aria-valuemax")), 1);
  await page.keyboard.press("Control+Shift+p");
  await expect(page.locator(".command-palette-dialog")).toBeVisible();
});

for (const zoomLevel of [80, 150]) {
  test(`divider pointer geometry follows CSS zoom at ${zoomLevel}%`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await restore(page, 2);
    const beforeCanvas = await page.locator(".pane-tree").evaluate(tree => (tree as HTMLElement).style.cssText);
    await page.evaluate(async zoom => {
      const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
      (await load()).settingsStore.update({ zoomLevel: zoom });
    }, zoomLevel);
    // Zoom updates CSS before ResizeObserver commits the new CSS-space canvas.
    // The ratio remains 50% in both generations, so it is not a readiness gate.
    let previousGeometry = "", stableSamples = 0;
    await expect.poll(async () => {
      const current = await page.locator(".pane-container").evaluate(container => {
        const tree = container.querySelector<HTMLElement>(".pane-tree")!;
        const rect = tree.getBoundingClientRect();
        return `${tree.style.cssText}|${container.clientWidth}x${container.clientHeight}|${rect.width}x${rect.height}`;
      });
      stableSamples = current === previousGeometry && !current.startsWith(`${beforeCanvas}|`) ? stableSamples + 1 : 0;
      previousGeometry = current;
      return stableSamples;
    }).toBeGreaterThanOrEqual(1);
    const divider = page.getByRole("separator", { name: "Resize panes" });
    await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeCloseTo(50, 1);
    const split = (await page.locator(".pane-split").boundingBox())!;
    const handle = (await divider.boundingBox())!;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(split.x + handle.width / 2 + (split.width - handle.width) * 0.55, y, { steps: 3 });
    await page.mouse.up();
    await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeCloseTo(55, 0);
    const first = (await page.locator(".explorer-pane").first().boundingBox())!;
    expect(first.width / (split.width - handle.width)).toBeCloseTo(0.55, 2);
  });
}

test("workspace scroll cancels a queued divider frame before it can change a saved ratio", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 500 });
  await restore(page);
  await focus(page, "viewport-0");
  const divider = page.locator(".pane-tree > .pane-split > .pane-divider");
  const handle = (await divider.boundingBox())!;
  // The tall root divider spans offscreen rows; press its visible top section.
  const viewport = (await page.locator(".pane-container").boundingBox())!;
  const y = Math.max(viewport.y, handle.y) + 40;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await expect(page.locator(".pane-split.resizing")).toHaveCount(1);
  await page.evaluate(() => {
    const callbacks: FrameRequestCallback[] = [];
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
    Object.assign(window, { __viewportFrames: () => {
      window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
      for (const callback of callbacks) callback(performance.now());
    } });
    window.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    window.cancelAnimationFrame = () => {};
  });
  await page.mouse.move(handle.x + 50, y);
  await page.locator(".pane-container").evaluate(viewport => { viewport.scrollTop += 100; });
  await expect(page.locator(".pane-split.resizing")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __viewportFrames(): void }).__viewportFrames());
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  const ratio = await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    return (await load()).windowTabsManager.captureState().tabs[0].layout.ratio;
  });
  expect(ratio).toBe(0.5);
});
