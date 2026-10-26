import { expect, test, type Page } from "./fixtures";
import { ALL_VIEW_VARIANTS } from "./helpers";
import { installLayoutInspector } from "./layout-inspector";
import { sampleFramesFromStartup, startFrameSampler, stopFrameSampler } from "./frame-sampler";

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

for (const viewMode of ["details", "list", "tiles"] as const) {
  for (const zoomLevel of [110, 130, 175]) {
    test(`${viewMode} sparse workspace fits without scrollbars at ${zoomLevel}%`, async ({ page }, info) => {
      await page.setViewportSize({ width: 817, height: 1361 });
      await page.addInitScript(({ zoomLevel }) => {
        localStorage.setItem("explorer-settings", JSON.stringify({
          showWindowControls: false, showSidebar: false, showStatusBar: false,
          zoomLevel, thumbnailSize: "small",
        }));
      }, { zoomLevel });
      await page.goto(`/?path=/home/user/Documents&viewMode=${viewMode}`);
      await page.locator(".entry-item").first().waitFor();
      // Measure the workspace itself: Details can legitimately scroll its columns.
      // ScrollHeight/clientHeight are integer-rounded and miss fractional overflow.
      await expect.poll(() => page.locator(".pane-container").evaluate(container => {
        const tree = container.querySelector<HTMLElement>(".pane-tree")!;
        const outer = container.getBoundingClientRect(), inner = tree.getBoundingClientRect();
        const style = getComputedStyle(container);
        const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
        const width = outer.width - (parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)) * zoom;
        const height = outer.height - (parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)) * zoom;
        return Math.max(Math.abs(inner.width - width), Math.abs(inner.height - height));
      })).toBeLessThanOrEqual(0.032);
      if (viewMode === "tiles" && zoomLevel === 130) {
        await page.screenshot({ path: info.outputPath("spacious-tiles-without-workspace-scrollbars.png") });
      }
    });
  }
}

for (const { name, viewMode, classic } of ALL_VIEW_VARIANTS) {
  // Column-flow List scrolls sideways; the classic (Folder Peek off) List scrolls vertically.
  const sideways = viewMode === "list" && !classic;
  test(`${name} overflowing files still reveal their final entry at fractional zoom`, async ({ page }, info) => {
    await page.setViewportSize({ width: 817, height: 600 });
    await page.addInitScript((folderPeek) => localStorage.setItem("explorer-settings", JSON.stringify({
      showSidebar: false, showStatusBar: false, zoomLevel: 130, thumbnailSize: "small", folderPeek,
    })), !classic);
    await page.goto(`/?path=/perf/huge-500&viewMode=${viewMode}`);
    await installLayoutInspector(page);
    await page.locator(".entry-item").first().click();
    const viewport = page.locator(`.${viewMode}-view .virtual-viewport`);
    const position = () => viewport.evaluate((element, sideways) => sideways ? element.scrollLeft : element.scrollTop, sideways);
    await expect.poll(() => viewport.evaluate((element, sideways) => sideways
      ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight, sideways)).toBeGreaterThan(100);
    const box = (await viewport.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(position).toBeGreaterThan(100);
    await page.keyboard.press("Control+End");
    await expect(page.getByRole("complementary", { name: "File inspector" })).toBeVisible();
    const selected = page.locator(".entry-item.selected");
    await expect(selected.locator(".entry-name")).toHaveText("image-00498.png");
    await expect(selected).toBeInViewport();
    await expect.poll(position).toBeGreaterThan(100);
    if (viewMode === "tiles") await page.screenshot({ path: info.outputPath("overflow-final-entry.png") });
  });
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
      settingsStore.update({ layoutTheme: "floating-islands", zoomLevel: 150 });
      for (const explorer of manager.getAllExplorers()) explorer.setViewMode(mode);
    }, viewMode);
    await expect(page.locator("html")).toHaveAttribute("data-layout-base", "floating-islands");
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
    const beforeWidth = await page.locator(".pane-container").evaluate(container => container.clientWidth);
    await page.evaluate(async zoom => {
      const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
      (await load()).settingsStore.update({ zoomLevel: zoom });
    }, zoomLevel);
    // Zoom resizes the CSS-space canvas immediately; the measured geometry that
    // divider input uses commits a frame later. The ratio remains 50% in both
    // generations, so it is not a readiness gate.
    await expect.poll(() => page.evaluate(async before => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const geometry = (await load()).windowTabsManager.paneViewport.geometry;
      const container = document.querySelector<HTMLElement>(".pane-container")!;
      return container.clientWidth !== before && !!geometry
        && Math.abs(geometry.width - container.clientWidth) < 1 && Math.abs(geometry.height - container.clientHeight) < 1;
    }, beforeWidth)).toBe(true);
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

for (const { name, viewMode, classic } of ALL_VIEW_VARIANTS) {
  const sideways = viewMode === "list" && !classic;
  test(`${name} resizing preserves a cursor intentionally scrolled out of view`, async ({ page }) => {
    await page.setViewportSize({ width: 817, height: 600 });
    await page.addInitScript((folderPeek) => localStorage.setItem("explorer-settings", JSON.stringify({
      showSidebar: false, showStatusBar: false, zoomLevel: 130, thumbnailSize: "small", folderPeek,
    })), !classic);
    await page.goto(`/?path=/perf/images-500&viewMode=${viewMode}`);
    await installLayoutInspector(page);
    await page.locator('.entry-item[data-index="1"]').click();
    await expect(page.getByRole("complementary", { name: "File inspector" })).toBeVisible();
    const viewport = page.locator(`.${viewMode}-view .virtual-viewport`);
    const position = () => viewport.evaluate((element, sideways) => sideways ? element.scrollLeft : element.scrollTop, sideways);
    const box = (await viewport.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 1400);
    await expect.poll(position).toBeGreaterThan(500);
    await expect(page.locator(".entry-item.selected")).toHaveCount(0);
    const before = { position: await position(), height: await viewport.evaluate(element => element.clientHeight) };
    await page.setViewportSize({ width: 817, height: 760 });
    await expect.poll(() => viewport.evaluate(element => element.clientHeight)).not.toBe(before.height);
    // WebKit can continue wheel momentum during the resize. It must never
    // jump back to the retained selection at the top of the collection.
    await expect.poll(position).toBeGreaterThanOrEqual(before.position);
    await expect(page.locator(".entry-item.selected")).toHaveCount(0);
  });
}

// Reveal, directional focus and divider input all read the measured geometry,
// while CSS paints the panes (#1061). Once settled, the two must agree.
for (const zoomLevel of [100, 130]) {
  for (const island of [false, true]) {
    test(`painted dense panes match the measured geometry at ${zoomLevel}%${island ? " in island mode" : ""}`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 480 });
      await page.addInitScript(settings => localStorage.setItem("explorer-settings", JSON.stringify(settings)),
        { zoomLevel, layoutTheme: island ? "floating-islands" : "default" });
      await restore(page);
      if (island) await expect(page.locator("html")).toHaveAttribute("data-layout-base", "floating-islands");
      const mismatch = () => page.evaluate(async () => {
        const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
        const geometry = (await load()).windowTabsManager.paneViewport.geometry;
        if (!geometry) return { panes: 0, worst: Infinity };
        // Client rects are in zoomed pixels; geometry is in the tree's CSS pixels.
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;left:-2000px;top:0;width:1000px;height:1px";
        document.body.append(probe);
        const scale = probe.getBoundingClientRect().width / 1000;
        probe.remove();
        const tree = document.querySelector(".pane-tree")!.getBoundingClientRect();
        let worst = Math.abs(tree.width / scale - geometry.width);
        worst = Math.max(worst, Math.abs(tree.height / scale - geometry.height));
        const elements = [...document.querySelectorAll<HTMLElement>(".explorer-pane")];
        for (const element of elements) {
          const want = geometry.panes.get(element.dataset.paneId!);
          if (!want) return { panes: elements.length, worst: Infinity };
          const rect = element.getBoundingClientRect();
          const got = [(rect.x - tree.x) / scale, (rect.y - tree.y) / scale, rect.width / scale, rect.height / scale];
          [want.x, want.y, want.w, want.h].forEach((value, i) => { worst = Math.max(worst, Math.abs(got[i] - value)); });
        }
        return { panes: elements.length, worst };
      });
      await expect.poll(async () => (await mismatch()).worst).toBeLessThanOrEqual(0.5);
      // The dense layout overflows this window: geometry is the clamped canvas.
      expect((await mismatch()).panes).toBe(16);
      expect(await page.locator(".pane-tree").evaluate(tree => tree.offsetWidth > tree.parentElement!.clientWidth)).toBe(true);
    });
  }
}

/** For the 16-pane layout: the worst overflow of any split's children and
 * dividers past the split, and how far the canvas minimum is from four 240 × 200
 * panes plus three of the dividers CSS is painting, along each axis. A stale
 * divider in the minima shows as overflow when it is too narrow and as a
 * mismatched canvas minimum either way. */
function splitOverflow() {
  let overflow = 0;
  for (const split of document.querySelectorAll<HTMLElement>(".pane-split")) {
    const row = split.classList.contains("row");
    const extent = (element: Element) => { const rect = element.getBoundingClientRect(); return row ? rect.width : rect.height; };
    const children = [...split.children].reduce((sum, child) => sum + extent(child), 0);
    overflow = Math.max(overflow, children - extent(split));
  }
  const tree = document.querySelector<HTMLElement>(".pane-tree")!;
  const divider = parseFloat(getComputedStyle(tree).getPropertyValue("--pane-divider-size"));
  const minimum = Math.max(Math.abs(parseFloat(tree.style.minWidth) - (4 * 240 + 3 * divider)),
    Math.abs(parseFloat(tree.style.minHeight) - (4 * 200 + 3 * divider)));
  return { island: document.documentElement.getAttribute("data-layout-base") === "floating-islands", overflow, minimum };
}
type OverflowSample = ReturnType<typeof splitOverflow>;

// Island mode widens the CSS dividers in the same render that applies it. The
// split minima must use that width in the same render too, not wait for the
// viewport measurement, or a constrained split overflows by the extra divider
// width for a frame: on startup, where no measurement exists yet, and on toggle.
for (const zoomLevel of [100, 130]) {
  test(`a dense island workspace never overflows its splits from the first frame at ${zoomLevel}%`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 });
    await page.addInitScript(({ settings, tabs }) => {
      localStorage.setItem("explorer-settings", JSON.stringify(settings));
      localStorage.setItem("explorer-tabs", JSON.stringify(tabs));
    }, { settings: { zoomLevel, layoutTheme: "floating-islands" }, tabs: { version: 3, activeTabId: "viewport-tab",
      tabs: [{ id: "viewport-tab", kind: "explorer", activePaneId: "viewport-15", layout: layout(Array.from({ length: 16 }, (_, i) => i)) }] } });
    await sampleFramesFromStartup(page, ".pane-split", splitOverflow);
    // A path parameter would replace the saved tabs.
    await page.goto("/");
    await expect(page.locator(".explorer-pane")).toHaveCount(16);
    await expect(page.locator("html")).toHaveAttribute("data-layout-base", "floating-islands");
    const samples = await stopFrameSampler<OverflowSample>(page);
    expect(samples.length).toBeGreaterThan(5);
    samples.forEach((sample, frame) => {
      expect(sample.overflow, `startup frame ${frame}`).toBeLessThanOrEqual(0.1);
      expect(sample.minimum, `startup frame ${frame} canvas minimum`).toBe(0);
    });
  });

  test(`island mode toggles never overflow a constrained split at ${zoomLevel}%`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 });
    await page.addInitScript(settings => localStorage.setItem("explorer-settings", JSON.stringify(settings)), { zoomLevel });
    await restore(page);
    const setIsland = (on: boolean) => page.evaluate(async value => {
      const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
      (await load()).settingsStore.update({ layoutTheme: value ? "floating-islands" : "default" });
    }, on);
    for (const island of [true, false]) {
      await startFrameSampler(page, splitOverflow);
      await setIsland(island);
      if (island) await expect(page.locator("html")).toHaveAttribute("data-layout-base", "floating-islands");
      else await expect(page.locator("html")).not.toHaveAttribute("data-layout-base", "floating-islands");
      const samples = await stopFrameSampler<OverflowSample>(page);
      const first = samples.findIndex(sample => sample.island === island);
      expect(first, "sampled frames before the toggle").toBeGreaterThan(0);
      samples.forEach((sample, frame) => {
        expect(sample.overflow, `frame ${frame} (island ${island})`).toBeLessThanOrEqual(0.1);
        expect(sample.minimum, `frame ${frame} (island ${island}) canvas minimum`).toBe(0);
      });
    }
  });
}
