/**
 * #1061: leaving the fullscreen image preview must not present a frame of the
 * Files tiles laid out for the fullscreen width. The first frame after exit
 * must already be the settled grid: the same tiles at the same positions.
 * Fullscreen no longer resizes the Files area at all, so the grid under it
 * must already be that settled grid.
 * Every dock edge, island mode and a fractional zoom must hold the same rule.
 *
 * `frame-sampler.ts` records the tile grid once per frame, just before paint.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, runPaletteCommand, pressShortcut } from "./helpers";
import { startFrameSampler, stopFrameSampler } from "./frame-sampler";

interface FrameSample {
  fullscreen: boolean;
  preview: boolean;
  viewport: number;
  panes: number[];
  columns: string | null;
  content: [number, number] | null;
  tiles: [string, number, number, number, number][];
}

interface Variant { name: string; dock: "right" | "bottom" | "top"; island: boolean; zoom: number }
const variants: Variant[] = [
  { name: "right dock", dock: "right", island: false, zoom: 100 },
  { name: "bottom dock", dock: "bottom", island: false, zoom: 100 },
  { name: "top dock", dock: "top", island: false, zoom: 100 },
  { name: "island mode", dock: "right", island: true, zoom: 100 },
  { name: "130% zoom", dock: "right", island: false, zoom: 130 },
  { name: "bottom dock, island mode, 115% zoom", dock: "bottom", island: true, zoom: 115 },
];

function useVariant(page: Page, { dock, island, zoom }: Variant) {
  return page.addInitScript((settings) => {
    localStorage.setItem("explorer-settings", JSON.stringify(settings));
  }, { previewPanePosition: dock, layoutTheme: island ? "floating-islands" : "default", zoomLevel: zoom });
}

async function openTilesWithImagePreview(page: Page, variant: Variant) {
  await useVariant(page, variant);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?path=/home/tiles-fullscreen");
  await waitForEntries(page);
  // The listing fills Details, leaving no background for the view menu.
  await runPaletteCommand(page, "Tiles View");
  await expect(page.locator(".tiles-view")).toBeVisible();
  if (!(await page.locator(".preview-pane").isVisible())) await pressShortcut(page, " ");
  await expect(page.locator(".preview-pane")).toBeVisible();
  await page.locator('.tile-item[data-path$="/shot-05.png"]').click();
  await expect(page.locator(".preview-image")).toHaveAttribute("alt", "shot-05.png");
}

async function enterFullscreen(page: Page) {
  await page.locator(".preview-image").click();
  await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  // Let the expanded background grid settle before sampling the exit.
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function snapshot(): FrameSample {
  const content = document.querySelector<HTMLElement>(".file-list > .content");
  return {
    fullscreen: !!document.querySelector(".preview-pane.fullscreen"),
    preview: !!document.querySelector(".preview-pane"),
    viewport: window.innerWidth,
    panes: [...document.querySelectorAll(".explorer-pane")].map((pane) => Math.round(pane.getBoundingClientRect().width)),
    columns: document.querySelector(".tiles-view")?.getAttribute("data-columns") ?? null,
    content: content ? [content.clientWidth, content.clientHeight] : null,
    tiles: [...document.querySelectorAll<HTMLElement>(".tiles-view .tile-item")].map((tile) => {
      const rect = tile.getBoundingClientRect();
      return [tile.dataset.path ?? "", Math.round(rect.x), Math.round(rect.y),
        Math.round(rect.width), Math.round(rect.height)];
    }),
  };
}
const startSampling = (page: Page) => startFrameSampler(page, snapshot);
const stopSampling = (page: Page) => stopFrameSampler<FrameSample>(page);

const exits = {
  Escape: (page: Page) => page.keyboard.press("Escape"),
  // The pane's own background: image descendants own their clicks.
  "double-click": (page: Page) => page.locator(".preview-pane").dispatchEvent("dblclick"),
  "image click": (page: Page) => page.locator(".preview-image").click(),
};

for (const variant of variants) {
  test.describe(variant.name, () => {
    for (const [exit, leave] of Object.entries(exits)) {
      test(`first frame after fullscreen ${exit} exit is the settled tile grid`, async ({ page }) => {
        await openTilesWithImagePreview(page, variant);
        for (let cycle = 0; cycle < 2; cycle++) {
          await enterFullscreen(page);
          await startSampling(page);
          await leave(page);
          await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
          const samples = await stopSampling(page);

          const during = samples.filter((sample) => sample.fullscreen);
          const after = samples.filter((sample) => !sample.fullscreen);
          expect(during.length, "sampled the fullscreen frames").toBeGreaterThan(0);
          expect(after.length, "sampled the frames after exit").toBeGreaterThan(5);
          const settled = after[after.length - 1];
          // Fullscreen leaves the Files area at its docked size, so the grid
          // under it is already the one exit reveals: same tracks, same tiles.
          expect({ ...during[0], fullscreen: false }, "grid under fullscreen").toEqual(settled);
          expect(settled.tiles).toHaveLength(27);

          after.forEach((sample, frame) => {
            expect(sample, `frame ${frame} after ${exit} exit (cycle ${cycle})`).toEqual(settled);
          });
          await expect(page.locator(".tile-item.selected")).toHaveAttribute("data-path", "/home/tiles-fullscreen/shot-05.png");
        }
      });
    }

    // The same Files size change happens when the docked preview opens or
    // closes and when the window is resized; neither may paint the previous layout.
    test("first frame after a docked preview toggle or window resize is the settled tile grid", async ({ page }) => {
      await openTilesWithImagePreview(page, variant);
      for (const visible of [false, true]) {
        await startSampling(page);
        await pressShortcut(page, " ");
        if (visible) await expect(page.locator(".preview-pane")).toBeVisible();
        else await expect(page.locator(".preview-pane")).toBeHidden();
        expectNoStaleFrame(await stopSampling(page), (sample) => sample.preview === visible, `preview ${visible ? "opens" : "closes"}`);
      }
      for (const width of [900, 1280]) {
        await startSampling(page);
        await page.setViewportSize({ width, height: 800 });
        expectNoStaleFrame(await stopSampling(page), (sample) => sample.viewport === width, `resize to ${width}px`);
      }
    });
  });
}

/** Every frame from the first one showing `changed` must equal the settled grid. */
function expectNoStaleFrame(samples: FrameSample[], changed: (sample: FrameSample) => boolean, label: string) {
  const first = samples.findIndex(changed);
  expect(first, `sampled frames before ${label}`).toBeGreaterThan(0);
  const after = samples.slice(first);
  expect(after.length, `sampled frames after ${label}`).toBeGreaterThan(5);
  const settled = after[after.length - 1];
  expect(settled.content, `${label} changes the Files area`).not.toEqual(samples[0].content);
  after.forEach((sample, frame) => expect(sample, `frame ${frame} after ${label}`).toEqual(settled));
}

// Split panes paint their saved ratio clamped to each pane's minimum. A window
// that narrows until the clamp binds must not paint the unclamped split first.
test("first frame after a resize that constrains a split keeps both panes at their settled sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.goto("/?path=/home/tiles-fullscreen");
  await waitForEntries(page);
  if (await page.locator(".preview-pane").isVisible()) await pressShortcut(page, " ");
  await expect(page.locator(".preview-pane")).toBeHidden();
  const leaf = (id: string) => ({ type: "leaf", id, path: "/home/tiles-fullscreen" });
  await page.evaluate(async (layout) => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    (await load()).windowTabsManager.restoreFromState({ version: 3, activeTabId: "split-tab",
      tabs: [{ id: "split-tab", kind: "explorer", activePaneId: "split-b", layout }] });
  }, { type: "split", id: "split-root", direction: "row", ratio: 0.25, first: leaf("split-a"), second: leaf("split-b") });
  await expect(page.locator(".explorer-pane")).toHaveCount(2);
  await expect.poll(async () => (await page.locator(".explorer-pane").first().boundingBox())!.width).toBeGreaterThan(300);

  await startSampling(page);
  await page.setViewportSize({ width: 1100, height: 800 });
  const samples = await stopSampling(page);
  const first = samples.findIndex((sample) => sample.viewport === 1100);
  expect(first, "sampled frames before the resize").toBeGreaterThan(0);
  const after = samples.slice(first);
  const settled = after[after.length - 1];
  // The narrower window makes the first pane's 240px minimum bind.
  expect(settled.panes[0]).toBeGreaterThanOrEqual(240);
  expect(settled.panes[0]).toBeLessThan(250);
  after.forEach((sample, frame) => expect(sample.panes, `frame ${frame} after the resize`).toEqual(settled.panes));
});
